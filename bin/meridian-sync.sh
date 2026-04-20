#!/usr/bin/env bash

# meridian-sync.sh
# Core orchestrator: Syncs standards and dynamically generates agents/skills based on roles.

set -e

# ANSI Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Meridian Agent & Skill Factory ===${NC}"

# Resolve the absolute path of the Meridian master directory
SOURCE_DIR="$(cd "$(dirname "$(readlink -f "$0" || echo "$0")")/.." && pwd)"
TARGET_DIR="$PWD"

echo -e "Source: ${YELLOW}${SOURCE_DIR}${NC}"
echo -e "Target: ${YELLOW}${TARGET_DIR}${NC}"

# Safety Check
if [ "$SOURCE_DIR" = "$TARGET_DIR" ]; then
    echo -e "${RED}Error: Running inside master directory. Please run from a target project root.${NC}"
    exit 1
fi

echo -e "\n${BLUE}[1/3] Preparing Meridian Infrastructure...${NC}"
mkdir -p "${TARGET_DIR}/.meridian/core"
mkdir -p "${TARGET_DIR}/.meridian/roles"
mkdir -p "${TARGET_DIR}/.gemini/agents"
mkdir -p "${TARGET_DIR}/.gemini/skills"
echo -e "${GREEN}Structure ready.${NC}"

echo -e "\n${BLUE}[2/3] Syncing Core Standards & Roles...${NC}"
# Copying Core Standards
if [ -d "${SOURCE_DIR}/.meridian/core" ]; then
    cp -R "${SOURCE_DIR}/.meridian/core/"* "${TARGET_DIR}/.meridian/core/"
    echo -e "  ✅ Core Standards synced."
fi

# Copying Roles
if [ -d "${SOURCE_DIR}/.meridian/roles" ]; then
    cp -R "${SOURCE_DIR}/.meridian/roles/"* "${TARGET_DIR}/.meridian/roles/"
    echo -e "  ✅ Roles synced."
fi

# Copying/Initializing agents.json in target
if [ -f "${SOURCE_DIR}/.meridian/agents.json" ]; then
    if [ ! -f "${TARGET_DIR}/.meridian/agents.json" ]; then
        # Initialize target with only non-expert agents
        python3 - <<EOF
import json
import os

source_path = "${SOURCE_DIR}/.meridian/agents.json"
target_path = "${TARGET_DIR}/.meridian/agents.json"

# Core roles that are considered "non-experts"
CORE_NAMES = [
    "software-architect", "software-engineer", "product-manager", 
    "quality-assurance", "devsecops", "site-reliability-engineer", 
    "staff-engineer", "engineering-manager"
]

with open(source_path, 'r') as f:
    all_agents = json.load(f)

# Filter for agents whose 'name' is in CORE_NAMES
core_agents = [a for a in all_agents if a.get('name') in CORE_NAMES]

with open(target_path, 'w') as f:
    json.dump(core_agents, f, indent=2)
EOF
        echo -e "  ✅ agents.json initialized with core roles (non-experts)."
    else
        echo -e "  ✅ agents.json already exists in target (using local version)."
    fi
fi

echo -e "\n${BLUE}[3/3] Generating Triggers (Agents & Skills)...${NC}"
# Generate everything from the TARGET'S agents.json
python3 - <<EOF
import json
import os

target_dir = "${TARGET_DIR}"
agents_json_path = os.path.join(target_dir, ".meridian/agents.json")

if not os.path.exists(agents_json_path):
    print(f"  ⚠️  Target {agents_json_path} not found. Generation skipped.")
    exit(0)

try:
    with open(agents_json_path, 'r') as f:
        agents = json.load(f)
except Exception as e:
    print(f"  ❌ Error reading {agents_json_path}: {e}")
    exit(1)

# Group agents by their role name to handle aliases cleanly
roles_map = {}
for agent in agents:
    name = agent.get('name')
    aid = agent.get('id')
    role_desc = agent.get('role', 'Specialized Meridian Agent')
    if not name or not aid: continue
    
    if name not in roles_map:
        roles_map[name] = {"ids": [], "role": role_desc}
    roles_map[name]["ids"].append(aid)

for name, data in roles_map.items():
    role_desc = data["role"]
    ids = data["ids"]
    
    # 1. Generate Agent Stubs for all aliases
    for aid in ids:
        agent_file = os.path.join(target_dir, ".gemini/agents", f"{aid}.md")
        agent_content = f"""---
name: {aid}
description: "{role_desc}"
---

# Agent Bootstrapping

Your complete identity and roles are defined at:
@../../.meridian/roles/{name}.md

**Critical Instruction:** 
Before performing anything, you MUST read and fully load the file above to understand your responsibility and global standards.
"""
        with open(agent_file, 'w') as f:
            f.write(agent_content)

    # 2. Generate Skill (.gemini/skills/[name]/SKILL.md)
    # Use 'call-' prefix for skill name to avoid collision with agent names
    skill_name = f"call-{name}"
    skill_dir = os.path.join(target_dir, ".gemini/skills", name)
    os.makedirs(skill_dir, exist_ok=True)
    skill_file = os.path.join(skill_dir, "SKILL.md")
    
    skill_title = name.replace('-', ' ').title()
    skill_content = f"""---
name: {skill_name}
description: Call the {skill_title} expertise and standards into the current session.
---

# Call {skill_title} Expertise

This skill injects the specialized knowledge, workflows, and standards of a {skill_title} directly into your current context.

@../../../.meridian/roles/{name}.md
"""
    with open(skill_file, 'w') as f:
        f.write(skill_content)

    # 3. Clean Log: Role (id1, id2) - agent + call-skill created/synced
    ids_str = ", ".join(ids)
    print(f"  ✅ {skill_title} ({ids_str}) - agent + {skill_name} created/synced")

print(f"\n\033[0;32mSuccessfully synced {len(roles_map)} roles ({len(agents)} triggers) based on local agents.json.\033[0m")
EOF

echo -e "\n${GREEN}=== Synchronization & Generation Complete! ===${NC}"
echo -e "Meridian infrastructure is active. Agents/Skills ready."
