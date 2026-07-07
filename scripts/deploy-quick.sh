#!/bin/bash

#============================================
# Quick Deploy Script for mongox (Non-interactive)
# Usage: ./scripts/deploy-quick.sh [commit_message]
#============================================

set -e

# Configuration
REMOTE_HOST="root@121.43.33.235"
REMOTE_PATH="/var/server/mongox"
PM2_APP_NAME="mongox"
PM2_CMD="/root/.nvm/versions/node/v22.22.1/bin/pm2"
BRANCH="dev"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}Quick Deploy - MongoDB Admin Web${NC}"
echo -e "${BLUE}============================================${NC}"

# Check if there are changes
if [ -z "$(git status --porcelain)" ]; then
    echo -e "${GREEN}✓${NC} No changes to commit"
    CHANGES_EXIST=false
else
    echo -e "${BLUE}→${NC} Found changes to commit"
    CHANGES_EXIST=true
fi

# Commit changes if any
if [ "$CHANGES_EXIST" = true ]; then
    echo -e "${BLUE}→${NC} Staging and committing changes..."
    git add -A || { echo -e "${RED}✗${NC} Failed to stage"; exit 1; }

    # Generate commit message if none provided
    if [ -n "$1" ]; then
        COMMIT_MSG="$*"
    else
        COMMIT_MSG="chore: auto-commit $(date +'%Y-%m-%d %H:%M:%S')"
    fi

    git commit -m "$COMMIT_MSG" || { echo -e "${RED}✗${NC} Failed to commit"; exit 1; }
    echo -e "${GREEN}✓${NC} Changes committed"
fi

# Push to remote
echo -e "${BLUE}→${NC} Pushing to origin/$BRANCH..."
git push origin "$BRANCH" || { echo -e "${RED}✗${NC} Failed to push"; exit 1; }
echo -e "${GREEN}✓${NC} Pushed"

# Deploy to remote: stash -> 3-way pull -> dep check -> reload -> health check
echo -e "${BLUE}→${NC} Deploying to remote..."
if ssh "$REMOTE_HOST" bash -s "$REMOTE_PATH" "$BRANCH" "$PM2_APP_NAME" "$PM2_CMD" <<'REMOTE_SCRIPT'
set -e
REMOTE_PATH="$1"; BRANCH="$2"; PM2_APP_NAME="$3"; PM2_CMD="$4"
HEALTH_URL="http://127.0.0.1:5000/mongo/api/health"

cd "$REMOTE_PATH"

if [ -n "$(git status --porcelain)" ]; then
    echo "== Remote dirty, stashing =="
    git stash push -m "deploy-auto-stash-$(date +%Y%m%d-%H%M%S)"
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
then
    echo -e "${GREEN}✓${NC} Deployed"
else
    echo -e "${RED}✗${NC} Deployment failed"
    echo -e "${RED}✗${NC} Recent logs: ssh $REMOTE_HOST \"$PM2_CMD logs $PM2_APP_NAME --lines 20 --nostream\""
    exit 1
fi

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
