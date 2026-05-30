# Skills: Web Clone

Skill package for cloning single public webpages into local Vite React Tailwind apps with Playwright capture, asset mirroring, and visual verification for Codex, Claude Code, and Gemini.

The workflow captures page structure, styles, assets, favicons, screenshots, and motion hints with Playwright; creates section contracts; assembles a local app; and verifies the result across desktop, tablet, and mobile viewports.

## Repository Overview

The package currently provides one skill:

- `web-clone/`
  - `SKILL.md`: core workflow, completion rules, and CLI usage
  - `scripts/`: Node.js tools for capture, contract creation, app assembly, and verification
  - `references/`: code generation and fidelity rules
  - `agents/openai.yaml`: optional Codex UI metadata
  - `package.json` / `package-lock.json`: runtime dependencies for the skill scripts
  - `setup.sh`: convenience setup wrapper for npm dependencies and Playwright Chromium

Typical use cases:

- Cloning a single public webpage into a local Vite React Tailwind app
- Capturing layout, CSS, assets, favicons, and motion hints for a page reconstruction task
- Generating section contracts for component rebuilding
- Verifying desktop, tablet, and mobile fidelity before considering a clone complete

## Installation

Clone this package first, then run the copy commands from the cloned directory:

```bash
git clone https://github.com/acentrist/web-clone-skills.git
cd web-clone-skills
```

If you already cloned it, run the install commands from that repository root. The path `./web-clone` must exist.

### 1) Codex

Copy the skill into `$CODEX_HOME/skills/`:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R web-clone "${CODEX_HOME:-$HOME/.codex}/skills/"
sh "${CODEX_HOME:-$HOME/.codex}/skills/web-clone/setup.sh"
```

Or install from a public GitHub repository with `$skill-installer`:

```text
$skill-installer install https://github.com/acentrist/web-clone-skills/tree/main/web-clone
```

After GitHub URL installation, install the runtime dependencies:

```bash
sh "${CODEX_HOME:-$HOME/.codex}/skills/web-clone/setup.sh"
```

Usage example:

```text
Use $web-clone to clone https://www.example.com/ into a local Vite React Tailwind app.
```

### 2) CC (Claude Code)

Use either a global or project-level installation.

Global:

```bash
mkdir -p "$HOME/.claude/skills"
cp -R web-clone "$HOME/.claude/skills/"
sh "$HOME/.claude/skills/web-clone/setup.sh"
```

Project-level:

```bash
mkdir -p .claude/skills
cp -R web-clone .claude/skills/
sh .claude/skills/web-clone/setup.sh
```

In prompts, explicitly request this skill, for example: `Please use the web-clone skill to clone https://www.example.com/`.

### 3) Gemini

Copy this skill into your Gemini skills directory:

```bash
mkdir -p "$HOME/.gemini/skills"
cp -R web-clone "$HOME/.gemini/skills/"
sh "$HOME/.gemini/skills/web-clone/setup.sh"
```

Then ask concrete cloning tasks in Gemini, for example: `Use the web-clone skill to clone https://www.example.com/`.

## Notes

- The runtime requires Node.js, npm, network access for the target page, and a Chromium runtime installed by Playwright.
- Generated apps, captured HTML, screenshots, mirrored third-party assets, and verification reports are local run artifacts.
- The default workflow writes local run artifacts under a host-named directory, for example `$HOME/web-clone-runs/example.com`.
- The skill is scoped to one public page. It does not crawl whole sites, recreate backend behavior, bypass authentication, or provide rights to third-party content.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
