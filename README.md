# METRICC
**Model, Edits, Time-windows, Release, Info, Context for Claude Code**

## A Clean, Lightweight, Design Focused Status Bar for Claude Code

[![Full HUD — click to view full-size](docs/images/hud-full-bar.png)](https://raw.githubusercontent.com/professionalcrastinationco/METRICC/main/docs/images/hud-full-bar.png)

> **Tip:** Click the image above to view it full-size.

No dependencies to install. Just one file.

---

## Why this exists

There are already a hundred Claude Code status bars. Most of them look like someone threw a JSON object at a terminal and called it a day. No offense. Ok, some offense.

I'm a graphic designer with 20+ years of experience and ADHD. I notice when something looks like shit, and I physically cannot parse cluttered information without my brain leaving the building. So I built the status bar I actually wanted to look at.

1. **Scannability** — Glance for half a second, get what you need. If you have to *read* a status bar, it failed.
2. **Zero visual noise** — No borders, no boxes, no unnecessary separators. Just the data, breathing.
3. **Zero extra dependencies** — Pure Claude Code API. Nothing to install, nothing to break.

If you want charts and twelve customizable widgets, there are great options out there. Genuinely. Go nuts. If you just want to glance down and know what's going on, this is it.

---

## Who built this?

Claude Code wrote the code. I just refused to accept "good enough" approximately forty-seven times in a row. Claude Code's contribution was not telling me to go fuck myself, which honestly showed remarkable restraint.

---

## What Each Piece Means

The screenshots below are **zoomed-in views** of each segment of the status bar so they're easy to read here on GitHub. These all sit side-by-side in a single line — to see the assembled result, scroll up to the full screenshot or click any segment image to view it full-size.

---

### Rate Limits — `5h` and `7d`

![Rate Limits](docs/images/seg-rate.png)

Your Anthropic API usage across two windows: the **5-hour** rolling window and the **7-day** rolling window. The percentage shows how much of your limit you've used. The time in parentheses is a countdown until that window resets.

The color changes automatically as you use more of your limit:

**Yellow** — getting close (60%+):

![Rate Limits warning](docs/images/seg-rate-warn.png)

**Red** — almost out (80%+):

![Rate Limits critical](docs/images/seg-rate-crit.png)

---

### Context Window

![Context Window](docs/images/seg-context.png)

How full the current conversation's context window is. This is the amount of "memory" Claude has for this session. The same green/yellow/red color coding applies — it turns yellow at 70% and red at 85%.

---

### Code Changes

![Code Changes](docs/images/seg-changes.png)

Lines of code **added** (green) and **removed** (red) during this session. A quick way to gauge how much work has been done without running `git diff`.

---

### Running Agents

![Running Agents](docs/images/seg-agents.png)

When Claude Code launches background agents (for research, exploration, etc.), they appear here. The count shows how many are active, and a tree view below the main bar shows details for each one:

- The letter badge shows the model — **s** (Sonnet), **O** (Opus), **h** (Haiku)
- How long the agent has been running
- What the agent is doing

Agents that have been running for over 30 minutes are automatically marked as stale and hidden.

---

### Todo Progress

![Todo Progress](docs/images/seg-todos.png)

When Claude Code is tracking tasks (via `TodoWrite` or `TaskCreate`), this shows how many are done out of the total. Yellow means there's still work to do — it turns green when all tasks are complete.

---

### Model and Version

![Model and Version](docs/images/seg-model-version.png)

The Claude model you're currently using (Opus 4.6, Sonnet 4.5, Haiku 4.5, etc.) and your Claude Code version. If a newer version is available, you'll see **(update avail)** in yellow. If you're on the latest, it just says **(latest)**.

---

## Setup

There are two steps: **save the file**, then **point Claude Code to it**.

### Step 1 — Save the script

You need to put `metricc-cc-statusbar.mjs` in a folder where it will stay. The recommended location is inside your Claude Code config folder.

<details>
<summary><strong>macOS / Linux</strong></summary>

Open a terminal and run:

```bash
mkdir -p ~/.claude/hud
curl -o ~/.claude/hud/metricc-cc-statusbar.mjs https://raw.githubusercontent.com/professionalcrastinationco/METRICC/main/metricc-cc-statusbar.mjs
```

This creates the folder and downloads the file in one go.

Your file is now at: `~/.claude/hud/metricc-cc-statusbar.mjs`

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

Open PowerShell and run:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\hud"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/professionalcrastinationco/METRICC/main/metricc-cc-statusbar.mjs" -OutFile "$env:USERPROFILE\.claude\hud\metricc-cc-statusbar.mjs"
```

Your file is now at: `C:\Users\<your-username>\.claude\hud\metricc-cc-statusbar.mjs`

</details>

<details>
<summary><strong>Manual download (any OS)</strong></summary>

1. Click on `metricc-cc-statusbar.mjs` in this repo
2. Click the **Raw** button (or **Download**)
3. Save the file to:
   - **macOS / Linux:** `~/.claude/hud/metricc-cc-statusbar.mjs`
   - **Windows:** `C:\Users\<your-username>\.claude\hud\metricc-cc-statusbar.mjs`
4. Create the `hud` folder first if it doesn't exist

</details>

### Step 2 — Tell Claude Code to use it

You need to add one setting to your Claude Code settings file.

**Where is the settings file?**

| OS | Path |
|----|------|
| macOS / Linux | `~/.claude/settings.json` |
| Windows | `C:\Users\<your-username>\.claude\settings.json` |

> If this file doesn't exist yet, just create it.

**Add this to your settings file:**

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/hud/metricc-cc-statusbar.mjs",
    "padding": 0
  }
}
```

> **Windows users:** Replace the path with your full Windows path:
> ```json
> "command": "node C:\\Users\\YourName\\.claude\\hud\\metricc-cc-statusbar.mjs"
> ```

If your settings file already has content, just merge the `statusLine` object into it. Don't replace what's already there.

<details>
<summary>Example: merging with existing settings</summary>

If your `settings.json` currently looks like this:

```json
{
  "env": {
    "SOME_OTHER_SETTING": "value"
  },
  "permissions": {
    "allow": ["Bash(npm test)"]
  }
}
```

Add the `statusLine` object alongside the existing keys:

```json
{
  "env": {
    "SOME_OTHER_SETTING": "value"
  },
  "permissions": {
    "allow": ["Bash(npm test)"]
  },
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/hud/metricc-cc-statusbar.mjs",
    "padding": 0
  }
}
```

</details>

<details>
<summary>Alternative: using the env var method</summary>

You can also configure the HUD using the `CLAUDE_CODE_STATUSLINE_COMMAND` environment variable. This works on most platforms but **may not work on WSL2 or some Linux setups**.

```json
{
  "env": {
    "CLAUDE_CODE_STATUSLINE_COMMAND": "node ~/.claude/hud/metricc-cc-statusbar.mjs"
  }
}
```

> **Windows users:** Replace the path with your full Windows path:
> ```json
> "CLAUDE_CODE_STATUSLINE_COMMAND": "node C:\\Users\\YourName\\.claude\\hud\\metricc-cc-statusbar.mjs"
> ```

If the env var method doesn't work for you, switch to the `statusLine` config object above — it's more reliable across all platforms.

</details>

### Step 3 — Restart Claude Code

Close and reopen Claude Code. The HUD will appear at the bottom of your terminal automatically.

> **Tip:** You can also ask Claude Code to do Step 2 for you. Just tell it:
> *"Set my statusline command to `node ~/.claude/hud/metricc-cc-statusbar.mjs`"*

### v2 — macOS Keychain Support

If you're on macOS and your Claude credentials are stored in the system Keychain rather than `~/.claude/.credentials.json`, use the v2 script instead.

**What's different:** v2 adds automatic macOS Keychain credential fallback. It looks for credentials in this order:

1. `~/.claude/.credentials.json` (same as v1 — works on all platforms)
2. macOS Keychain via `security find-generic-password` (macOS only)

If your JSON credentials file exists and has a valid token, v2 behaves identically to v1. The Keychain fallback only kicks in when the JSON file is missing or empty.

**Who should use v2:** macOS users whose Claude Code stores credentials in Keychain. If you're on Windows or Linux, v1 is all you need.

**Setup:** Same two steps as above — just swap the filename.

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
mkdir -p ~/.claude/hud
curl -o ~/.claude/hud/metricc-cc-statusbar-v2.mjs https://raw.githubusercontent.com/professionalcrastinationco/METRICC/main/metricc-cc-statusbar-v2.mjs
```

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\hud"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/professionalcrastinationco/METRICC/main/metricc-cc-statusbar-v2.mjs" -OutFile "$env:USERPROFILE\.claude\hud\metricc-cc-statusbar-v2.mjs"
```

</details>

Then point your `statusLine` command to the v2 file:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/hud/metricc-cc-statusbar-v2.mjs",
    "padding": 0
  }
}
```

## Requirements

- **Node.js 18 or newer** — you already have this if Claude Code is installed
- **Claude Code** with an active login — the HUD uses your existing session for rate limit data

<details>
<summary><strong>Technical Details</strong></summary>

### How It Works

Claude Code sends JSON data to the statusline command every time the display refreshes. The HUD reads that data and:

1. Calculates context window usage from token counts
2. Fetches your rate limits from the Anthropic API (cached for 60 seconds)
3. Reads the session transcript to find running agents and todo progress
4. Checks npm for the latest Claude Code version (cached for 1 hour)
5. Renders everything as a color-coded status line

All network requests happen simultaneously so the HUD stays fast.

### Agent Tracking

When agents are running, they appear in a tree view below the main status line:

- A letter badge shows the model: **O** (Opus), **s** (Sonnet), **h** (Haiku)
- Elapsed time since the agent started
- The agent type and a short description
- Agents older than 30 minutes are automatically hidden
- Up to 100 agents are tracked per session

### Caching

| Data | Refreshes every | Stored at |
|------|-----------------|-----------|
| Rate limits | 60 seconds | `~/.claude/hud/.usage-cache.json` |
| CC version | 1 hour | `~/.claude/hud/.version-cache.json` |

</details>

## Acknowledgments

METRICC was inspired by and (maybe borrowed some code from — Claude Coded it) the [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) framework. OMC is a multi-agent orchestration system for Claude Code — go check it out if you haven't already.

## License

MIT