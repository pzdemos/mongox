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
PM2_CMD="/root/.nvm/versions/node/v21.7.3/bin/pm2"
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

# Deploy to remote
echo -e "${BLUE}→${NC} Deploying to remote..."
ssh "$REMOTE_HOST" "cd $REMOTE_PATH && git pull origin $BRANCH && $PM2_CMD restart $PM2_APP_NAME" || {
    echo -e "${RED}✗${NC} Deployment failed"
    exit 1
}
echo -e "${GREEN}✓${NC} Deployed"

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
