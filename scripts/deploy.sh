#!/bin/bash

#============================================
# Auto Deploy Script for mongox (MongoDB Admin Web)
# Usage: ./scripts/deploy.sh [commit_message]
#============================================

set -e  # Exit on error

#============================================
# Configuration
#============================================
REMOTE_HOST="root@121.43.33.235"
REMOTE_PATH="/var/server/mongox"
PM2_APP_NAME="mongox"
PM2_CMD="/root/.nvm/versions/node/v22.22.1/bin/pm2"
BRANCH="dev"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

#============================================
# Functions
#============================================

# Print colored message
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Print section header
print_section() {
    echo ""
    echo -e "${BLUE}============================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}============================================${NC}"
}

# Check command result
check_result() {
    if [ $? -ne 0 ]; then
        print_error "$1"
        exit 1
    fi
}

# Check if we're in a git repository
check_git_repo() {
    if [ ! -d ".git" ]; then
        print_error "Not a git repository!"
        exit 1
    fi
}

# Check for uncommitted changes
check_changes() {
    print_section "Checking for changes"

    if [ -z "$(git status --porcelain)" ]; then
        print_warning "No changes to commit"
        read -p "Continue with deployment anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_info "Deployment cancelled"
            exit 0
        fi
        return 1
    else
        print_info "Found changes to commit"
        git status --short
        return 0
    fi
}

# Run pre-commit checks
run_pre_commit_checks() {
    print_section "Running pre-commit checks"

    # Check if npm is available
    if command -v npm &> /dev/null; then
        print_info "Running npm run check..."
        npm run check || print_warning "Check found issues (continuing anyway)"
    fi

    # Add more checks here as needed
    # - Run tests
    # - Check for console.log
    # - Validate package.json
}

# Stage and commit changes
commit_changes() {
    print_section "Committing changes"

    local commit_msg="$1"

    # If no commit message provided, generate one
    if [ -z "$commit_msg" ]; then
        read -p "Enter commit message: " commit_msg
        if [ -z "$commit_msg" ]; then
            print_error "Commit message is required"
            exit 1
        fi
    fi

    # Stage all changes
    print_info "Staging changes..."
    git add -A
    check_result "Failed to stage changes"

    # Show what will be committed
    print_info "Changes to be committed:"
    git diff --cached --stat

    # Confirm commit
    read -p "Commit these changes? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_error "Commit cancelled"
        exit 1
    fi

    # Create commit
    print_info "Creating commit..."
    git commit -m "$commit_msg"
    check_result "Failed to create commit"
    print_success "Commit created"
}

# Push to remote
push_to_remote() {
    print_section "Pushing to remote"

    print_info "Pushing to origin/$BRANCH..."
    git push origin "$BRANCH"
    check_result "Failed to push to remote"
    print_success "Pushed to origin/$BRANCH"
}

# Deploy to remote server
deploy_to_remote() {
    print_section "Deploying to remote server"

    # Test SSH connection
    print_info "Testing SSH connection..."
    ssh -o ConnectTimeout=5 "$REMOTE_HOST" "echo 'Connection successful'"
    check_result "SSH connection failed"
    print_success "SSH connection OK"

    # Run remote workflow: stash -> 3-way pull -> dep check -> reload -> health check
    print_info "Syncing code and reloading remote..."
    ssh "$REMOTE_HOST" bash -s "$REMOTE_PATH" "$BRANCH" "$PM2_APP_NAME" "$PM2_CMD" <<'REMOTE_SCRIPT'
set -e
REMOTE_PATH="$1"; BRANCH="$2"; PM2_APP_NAME="$3"; PM2_CMD="$4"
HEALTH_URL="http://127.0.0.1:5000/mongo/api/health"

cd "$REMOTE_PATH"

# Stash if dirty (e.g. operator-edited runtime files)
if [ -n "$(git status --porcelain)" ]; then
    echo "== Remote dirty, stashing =="
    git stash push -m "deploy-auto-stash-$(date +%Y%m%d-%H%M%S)"
fi

# 3-way pull decision
git fetch origin "$BRANCH"
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse "origin/$BRANCH")
BASE=$(git merge-base @ "origin/$BRANCH")

NEED_INSTALL=false
if [ "$LOCAL" = "$REMOTE" ]; then
    echo "== Already up to date =="
elif [ "$LOCAL" = "$BASE" ]; then
    BEFORE=$(git rev-parse HEAD)
    echo "== Pulling new commits =="
    git pull --ff-only origin "$BRANCH"
    git diff --name-only "$BEFORE" HEAD | grep -qE '^(package\.json|package-lock\.json)$' && NEED_INSTALL=true
else
    BEFORE=$(git rev-parse HEAD)
    echo "== Local diverged, force sync to origin/$BRANCH =="
    git reset --hard "origin/$BRANCH"
    git diff --name-only "$BEFORE" HEAD | grep -qE '^(package\.json|package-lock\.json)$' && NEED_INSTALL=true
fi

if [ "$NEED_INSTALL" = true ]; then
    echo "== package.json changed, running npm install =="
    npm install --omit=dev
fi

# Reload PM2 (zero-downtime cluster reload)
echo "== Reloading PM2 app: $PM2_APP_NAME =="
"$PM2_CMD" reload "$PM2_APP_NAME"

# Health check (cluster reload is rolling; give new workers a moment)
echo "== Waiting for service (2s) =="
sleep 2
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "== Health check passed (HTTP 200) =="
else
    echo "== Health check FAILED (HTTP $HTTP_CODE), dumping logs =="
    "$PM2_CMD" logs "$PM2_APP_NAME" --lines 30 --nostream
    exit 1
fi
REMOTE_SCRIPT
    check_result "Remote deploy failed (see output above)"
    print_success "Deployment verified (HTTP 200)"
}

# Diagnose failure (does NOT auto-rollback — too risky on shared branch)
diagnose_failure() {
    print_section "Deployment Failed - Diagnostic Info"

    print_warning "Deployment failed. Gathering diagnostic info..."

    print_info "Remote git HEAD:"
    ssh "$REMOTE_HOST" "cd $REMOTE_PATH && git log --oneline -3" 2>/dev/null || true

    print_info "Recent PM2 logs (last 20 lines):"
    ssh "$REMOTE_HOST" "$PM2_CMD logs $PM2_APP_NAME --lines 20 --nostream" 2>/dev/null || true

    print_warning "If bad code was pushed, manual rollback:"
    print_warning "  ssh $REMOTE_HOST \"cd $REMOTE_PATH && git reset --hard HEAD~1 && $PM2_CMD reload $PM2_APP_NAME\""
}

# Main execution
main() {
    print_section "MongoDB Admin Web (mongox) Auto Deploy"

    # Save current directory
    local current_dir=$(pwd)
    cd "$(dirname "$0")/.." || exit 1

    # Trap errors for diagnostics
    trap 'diagnose_failure; cd "$current_dir"' ERR

    # Execute workflow
    check_git_repo

    if check_changes; then
        run_pre_commit_checks
        commit_changes "$1"
    fi

    push_to_remote
    deploy_to_remote

    # Success message
    print_section "Deployment Complete"
    print_success "All operations completed successfully!"
    echo ""
    print_info "App URL: https://mongo.haoaiganfan.top"
    print_info "PM2 Status: ssh $REMOTE_HOST \"$PM2_CMD status\""
    print_info "View Logs: ssh $REMOTE_HOST \"$PM2_CMD logs $PM2_APP_NAME --lines 50\""

    cd "$current_dir"
}

# Parse command line arguments
case "${1:-}" in
    -h|--help)
        echo "Usage: $0 [commit_message]"
        echo ""
        echo "Automates the deployment process:"
        echo "  1. Checks for changes"
        echo "  2. Runs pre-commit checks"
        echo "  3. Commits changes"
        echo "  4. Pushes to remote"
        echo "  5. Deploys to production"
        echo ""
        echo "Examples:"
        echo "  $0 \"fix: update query parser\""
        echo "  $0"
        exit 0
        ;;
    *)
        main "$@"
        ;;
esac
