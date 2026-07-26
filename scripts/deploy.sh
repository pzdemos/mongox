#!/bin/bash

#============================================
# Auto Deploy Script for mongox + SqlX
# Usage: ./scripts/deploy.sh [commit_message]
# Env:
#   SQLX_DIR   frontend path (default: ../SqlX)
#   SKIP_LINT  set to 1 to skip frontend lint
#============================================

set -e

#============================================
# Configuration
#============================================
REMOTE_HOST="root@121.43.33.235"
REMOTE_PATH="/var/server/mongox"
PM2_APP_NAME="mongox"
BRANCH="dev"
# PM2_CMD 由 resolve_pm2_cmd() 在运行时解析

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

print_section() {
    echo ""
    echo -e "${BLUE}============================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}============================================${NC}"
}

check_result() {
    if [ $? -ne 0 ]; then
        print_error "$1"
        exit 1
    fi
}

check_git_repo() {
    if [ ! -d ".git" ]; then
        print_error "Not a git repository!"
        exit 1
    fi
}

resolve_pm2_cmd() {
    print_section "Resolving PM2 on remote"

    print_info "Probing pm2 path on $REMOTE_HOST..."
    if ! PM2_CMD=$(ssh -o ConnectTimeout=5 "$REMOTE_HOST" 'bash -lc "command -v pm2" 2>/dev/null'); then
        print_error "SSH failed while resolving pm2"
        exit 1
    fi
    PM2_CMD=$(printf '%s' "$PM2_CMD" | awk 'NF{line=$0} END{print line}')
    if [ -z "$PM2_CMD" ]; then
        print_error "pm2 not found on remote — check nvm installation or login shell PATH"
        exit 1
    fi
    print_success "PM2: $PM2_CMD"
}

build_frontend() {
    print_section "Building frontend (SqlX → public/)"
    bash "$(dirname "$0")/build-frontend.sh"
    check_result "Frontend build failed"
    print_success "Frontend ready in public/ (gitignored build artifacts)"
}

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

run_pre_commit_checks() {
    print_section "Running pre-commit checks"

    if command -v npm &> /dev/null; then
        print_info "Running npm run check..."
        npm run check || print_warning "Check found issues (continuing anyway)"
    fi
}

commit_changes() {
    print_section "Committing changes"

    local commit_msg="$1"

    if [ -z "$commit_msg" ]; then
        read -p "Enter commit message: " commit_msg
        if [ -z "$commit_msg" ]; then
            print_error "Commit message is required"
            exit 1
        fi
    fi

    print_info "Staging changes..."
    git add -A
    check_result "Failed to stage changes"

    print_info "Changes to be committed:"
    git diff --cached --stat

    read -p "Commit these changes? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_error "Commit cancelled"
        exit 1
    fi

    print_info "Creating commit..."
    git commit -m "$commit_msg"
    check_result "Failed to create commit"
    print_success "Commit created"
}

push_to_remote() {
    print_section "Pushing to remote"

    print_info "Pushing to origin/$BRANCH..."
    git push origin "$BRANCH"
    check_result "Failed to push to remote"
    print_success "Pushed to origin/$BRANCH"
}

# 通过 scp/rsync 上传 public（含构建产物与 v1）
sync_public_to_remote() {
    print_section "Uploading public/ via rsync/scp"

    if [ ! -f "public/index.html" ]; then
        print_error "public/index.html missing — run frontend build first"
        exit 1
    fi

    print_info "Ensuring remote public dir exists..."
    ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_PATH/public'"
    check_result "Failed to create remote public dir"

    if command -v rsync >/dev/null 2>&1; then
        print_info "rsync public/ → $REMOTE_HOST:$REMOTE_PATH/public/"
        # 完整同步 public（含 v1 + 构建产物）；--delete 使远端与本地一致
        rsync -az --delete -e ssh "public/" "$REMOTE_HOST:$REMOTE_PATH/public/"
        check_result "rsync public failed"
    else
        print_warning "rsync 不可用，回退 scp -r"
        ssh "$REMOTE_HOST" "rm -rf '$REMOTE_PATH/public' && mkdir -p '$REMOTE_PATH/public'"
        scp -r public/. "$REMOTE_HOST:$REMOTE_PATH/public/"
        check_result "scp public failed"
    fi
    print_success "public/ uploaded"
}

deploy_to_remote() {
    print_section "Deploying backend code on remote"

    print_info "Testing SSH connection..."
    ssh -o ConnectTimeout=5 "$REMOTE_HOST" "echo 'Connection successful'"
    check_result "SSH connection failed"
    print_success "SSH connection OK"

    print_info "Syncing git code and reloading remote..."
    ssh "$REMOTE_HOST" bash -s "$REMOTE_PATH" "$BRANCH" "$PM2_APP_NAME" "$PM2_CMD" <<'REMOTE_SCRIPT'
set -e
REMOTE_PATH="$1"; BRANCH="$2"; PM2_APP_NAME="$3"; PM2_CMD="$4"
HEALTH_URL="http://127.0.0.1:5000/mongo/api/health"

cd "$REMOTE_PATH"

if [ -n "$(git status --porcelain)" ]; then
    echo "== Remote dirty, stashing =="
    git stash push -m "deploy-auto-stash-$(date +%Y%m%d-%H%M%S)" || true
fi

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

# git pull 可能用仓库内的 public/v1 覆盖；构建产物稍后由 rsync 补回
if [ "$NEED_INSTALL" = true ]; then
    echo "== package.json changed, running npm install =="
    npm install --omit=dev
fi

echo "== Reloading PM2 app: $PM2_APP_NAME =="
"$PM2_CMD" reload "$PM2_APP_NAME"

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
    print_success "Backend deploy verified (HTTP 200)"
}

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

main() {
    print_section "mongox + SqlX Auto Deploy"

    local current_dir
    current_dir=$(pwd)
    cd "$(dirname "$0")/.." || exit 1

    trap 'diagnose_failure; cd "$current_dir"' ERR

    check_git_repo
    resolve_pm2_cmd

    # 1) 前端检查 + 打包到 public/
    build_frontend

    # 2) 后端变更提交（若有）
    if check_changes; then
        run_pre_commit_checks
        commit_changes "$1"
    fi

    # 3) 推送后端代码
    push_to_remote

    # 4) 远程 pull + pm2 reload
    deploy_to_remote

    # 5) 再上传 public（避免 git reset/pull 清掉被 ignore 的构建产物）
    sync_public_to_remote

    # 6) 上传静态资源后再 reload 一次，确保进程读到最新文件（express.static 无缓存问题，reload 更稳妥）
    print_section "Reload after public sync"
    ssh "$REMOTE_HOST" bash -lc "'$PM2_CMD' reload '$PM2_APP_NAME'"
    sleep 1
    HTTP_CODE=$(ssh "$REMOTE_HOST" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/mongo/api/health" || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        print_success "Post-upload health OK"
    else
        print_error "Post-upload health failed (HTTP $HTTP_CODE)"
        exit 1
    fi

    print_section "Deployment Complete"
    print_success "All operations completed successfully!"
    echo ""
    print_info "App URL: https://mongo.haoaiganfan.top"
    print_info "Legacy UI: https://mongo.haoaiganfan.top/v1/"
    print_info "PM2 Status: ssh $REMOTE_HOST \"$PM2_CMD status\""
    print_info "View Logs: ssh $REMOTE_HOST \"$PM2_CMD logs $PM2_APP_NAME --lines 50\""

    cd "$current_dir"
}

case "${1:-}" in
    -h|--help)
        echo "Usage: $0 [commit_message]"
        echo ""
        echo "Automates deployment:"
        echo "  1. Check & build sibling SqlX → public/"
        echo "  2. Commit backend changes (interactive)"
        echo "  3. Push origin/$BRANCH"
        echo "  4. Remote git pull + pm2 reload"
        echo "  5. rsync/scp public/ (build artifacts gitignored)"
        echo ""
        echo "Examples:"
        echo "  $0 \"fix: update query parser\""
        echo "  SQLX_DIR=/path/to/SqlX $0"
        echo "  SKIP_LINT=1 $0"
        exit 0
        ;;
    *)
        main "$@"
        ;;
esac
