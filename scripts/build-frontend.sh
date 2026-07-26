#!/bin/bash
#============================================
# Build SqlX frontend into mongox/public
# Usage (from mongox root or any cwd):
#   ./scripts/build-frontend.sh
# Env:
#   SQLX_DIR   frontend path (default: <mongox>/../SqlX)
#   SKIP_LINT  set to 1 to skip pnpm run lint
#============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLIC_DIR="$BACKEND_ROOT/public"
V1_DIR="$PUBLIC_DIR/v1"
SQLX_DIR="${SQLX_DIR:-$(cd "$BACKEND_ROOT/.." && pwd)/SqlX}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[frontend]${NC} $1"; }
ok() { echo -e "${GREEN}[frontend]${NC} $1"; }
warn() { echo -e "${YELLOW}[frontend]${NC} $1"; }
err() { echo -e "${RED}[frontend]${NC} $1"; }

resolve_pm() {
  if command -v pnpm >/dev/null 2>&1; then
    PM=pnpm
    return
  fi
  if command -v npm >/dev/null 2>&1; then
    PM=npm
    warn "pnpm 未找到，回退使用 npm"
    return
  fi
  err "未找到 pnpm 或 npm"
  exit 1
}

ensure_v1_archive() {
  mkdir -p "$V1_DIR"
  # 若根目录仍有旧单页且 v1 尚未归档，则迁入 v1
  if [ ! -f "$V1_DIR/index.html" ]; then
    local moved=0
    for f in index.html app.js styles.css login.html; do
      if [ -f "$PUBLIC_DIR/$f" ]; then
        mv "$PUBLIC_DIR/$f" "$V1_DIR/$f"
        moved=1
      fi
    done
    if [ "$moved" -eq 1 ]; then
      ok "已将旧单页归档到 public/v1/"
    fi
  fi
  if [ ! -f "$V1_DIR/index.html" ]; then
    warn "public/v1/index.html 不存在（可忽略，若仓库已归档）"
  else
    ok "public/v1 就绪"
  fi
}

check_frontend() {
  info "前端目录: $SQLX_DIR"
  if [ ! -d "$SQLX_DIR" ]; then
    err "未找到前端目录（同级 SqlX）。可用 SQLX_DIR 指定路径"
    exit 1
  fi
  if [ ! -f "$SQLX_DIR/package.json" ]; then
    err "缺少 package.json，不满足打包条件"
    exit 1
  fi

  local has_lock=0
  if [ -f "$SQLX_DIR/pnpm-lock.yaml" ] || [ -f "$SQLX_DIR/package-lock.json" ] || [ -f "$SQLX_DIR/yarn.lock" ]; then
    has_lock=1
  fi
  if [ "$has_lock" -ne 1 ]; then
    err "缺少 lockfile（pnpm-lock.yaml / package-lock.json），依赖不完备"
    exit 1
  fi

  if [ ! -d "$SQLX_DIR/node_modules" ]; then
    warn "node_modules 不存在，开始安装依赖..."
    (cd "$SQLX_DIR" && "$PM" install)
  else
    ok "node_modules 已存在"
  fi

  # 关键依赖抽查（Vite React 前端）
  if [ ! -d "$SQLX_DIR/node_modules/vite" ] || [ ! -d "$SQLX_DIR/node_modules/react" ]; then
    warn "关键依赖缺失，重新安装..."
    (cd "$SQLX_DIR" && "$PM" install)
  fi
  if [ ! -d "$SQLX_DIR/node_modules/vite" ] || [ ! -d "$SQLX_DIR/node_modules/react" ]; then
    err "依赖安装后仍缺少 vite/react，中止打包"
    exit 1
  fi
  ok "打包前置检查通过"
}

build_and_sync() {
  if [ "${SKIP_LINT:-0}" != "1" ]; then
    if grep -q '"lint"' "$SQLX_DIR/package.json"; then
      info "运行 lint..."
      (cd "$SQLX_DIR" && "$PM" run lint)
      ok "lint 通过"
    fi
  else
    warn "已跳过 lint（SKIP_LINT=1）"
  fi

  info "执行 $PM run build..."
  (cd "$SQLX_DIR" && "$PM" run build)

  local dist="$SQLX_DIR/dist"
  if [ ! -f "$dist/index.html" ]; then
    err "构建失败：未找到 $dist/index.html"
    exit 1
  fi
  ok "构建完成: $dist"

  ensure_v1_archive
  mkdir -p "$PUBLIC_DIR"

  info "同步到 $PUBLIC_DIR （保留 v1/）..."
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude 'v1/' "$dist/" "$PUBLIC_DIR/"
  else
    # 无 rsync 时：清掉非 v1 内容再复制
    find "$PUBLIC_DIR" -mindepth 1 -maxdepth 1 ! -name 'v1' -exec rm -rf {} +
    cp -R "$dist"/. "$PUBLIC_DIR"/
  fi

  if [ ! -f "$PUBLIC_DIR/index.html" ]; then
    err "同步后缺少 public/index.html"
    exit 1
  fi
  ok "前端已写入 public/（构建产物应由 .gitignore 排除）"
}

main() {
  resolve_pm
  check_frontend
  build_and_sync
}

main "$@"
