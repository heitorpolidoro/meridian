#!/usr/bin/env bash

# meridian-sync.sh
# Copies Meridian Core Standards, Roles, and Agent Stubs into the current directory.
# Useful for initializing or updating a project with the Meridian ecosystem without relying on fragile symlinks.

set -e

# ANSI Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Meridian Agent Synchronizer ===${NC}"

# Resolve the absolute path of the Meridian master directory (where this script lives)
# Follow symlinks if the script itself is symlinked
SOURCE_DIR="$(cd "$(dirname "$(readlink -f "$0" || echo "$0")")/.." && pwd)"
TARGET_DIR="$PWD"

echo -e "Source: ${YELLOW}${SOURCE_DIR}${NC}"
echo -e "Target: ${YELLOW}${TARGET_DIR}${NC}"

# Safety Check: Prevent running inside the source directory itself
if [ "$SOURCE_DIR" = "$TARGET_DIR" ]; then
    echo -e "${RED}Error: You are running this script inside the Meridian master directory.${NC}"
    echo -e "${RED}Please run this script from the root of a target project (e.g., ~/workspace/my-new-app).${NC}"
    exit 1
fi

echo -e "\n${BLUE}[1/3] Preparing target directories...${NC}"
mkdir -p "${TARGET_DIR}/.meridian/core"
mkdir -p "${TARGET_DIR}/.meridian/roles"
mkdir -p "${TARGET_DIR}/.gemini/agents"
echo -e "${GREEN}Directories ready.${NC}"

echo -e "\n${BLUE}[2/3] Synchronizing Core Standards & Roles...${NC}"
# Copying Core Standards (The Soul)
if [ -d "${SOURCE_DIR}/.meridian/core" ]; then
    cp -R "${SOURCE_DIR}/.meridian/core/"* "${TARGET_DIR}/.meridian/core/"
    echo -e "  ✅ Core Standards synced."
else
    echo -e "  ⚠️ Source core directory not found. Skipping."
fi

# Copying Roles (The Brain)
if [ -d "${SOURCE_DIR}/.meridian/roles" ]; then
    cp -R "${SOURCE_DIR}/.meridian/roles/"* "${TARGET_DIR}/.meridian/roles/"
    echo -e "  ✅ Roles synced."
else
    echo -e "  ⚠️ Source roles directory not found. Skipping."
fi

echo -e "\n${BLUE}[3/3] Synchronizing Agent Stubs...${NC}"
# Copying Stubs (The Triggers)
if [ -d "${SOURCE_DIR}/.gemini/agents" ]; then
    cp -R "${SOURCE_DIR}/.gemini/agents/"*.md "${TARGET_DIR}/.gemini/agents/" 2>/dev/null || echo -e "  ⚠️ No markdown stubs found."
    echo -e "  ✅ Agent Stubs synced."
else
    echo -e "  ⚠️ Source agents directory not found. Skipping."
fi

# Note: The relative paths in the stubs (@../../.meridian/roles/...) will work perfectly 
# because the target structure matches the source structure.

echo -e "\n${GREEN}=== Synchronization Complete! ===${NC}"
echo -e "The Meridian agents and standards are now available in your project."
echo -e "Tip: You can add an alias in your ~/.bashrc or ~/.zshrc for easier access:"
echo -e "     alias meridian-sync=\"${SOURCE_DIR}/bin/meridian-sync.sh\"\n"
