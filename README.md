# Shuteye

**Talk to Claude Code with your eyes shut.** Tap once, speak, and the answer is read out loud. Hands-free mode listens again after every answer, so you can lie down, close your eyes and keep working.

It was built by someone who reads a screen 18 hours a day and needed his eyes back. Claude's chat app has a voice mode; Claude Code on a phone does not. Shuteye is a small bridge: your phone's browser does the listening and the speaking, and Claude Code runs on your own computer with your own login.

- Zero dependencies: one Node file and one HTML page.
- **Read-only by default.** It can read your project and answer. It cannot run commands or change files unless you start it with `--full-powers`.
- In full-powers mode it says what it is about to change and waits for your "yes" before it does it.
- You connect a phone with a one-time pairing link (it works once, within 15 minutes). The key itself is never printed or put in a link.

## Plant a tree

Star Shuteye from a GitHub account that is at least 30 days old, and a tree with your GitHub name grows in [Shuteye Park](https://apexfaucet.xyz/arc/city/#park), in Arc City. The age rule keeps the park to real people.

## Start

You need Node 18 or newer, a recent [Claude Code](https://docs.claude.com/en/docs/claude-code) (tested with 2.1.281) installed and logged in, and Chrome on your phone.

```bash
git clone https://github.com/apexfaucet-hub/shuteye
cd shuteye
node server.js --dir /path/to/your/project --tunnel
```

It prints a one-time pairing link. `--tunnel` starts a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (install `cloudflared` first) and prints the pairing link with an https address. Open it on your phone once; the phone stores the key and the link is used up. To connect another phone, run `node server.js --pair` while Shuteye is running. The microphone only works over https, so a plain `http://192.168...` address will not do; you can also put Shuteye behind your own https proxy and use `--base /voice` if it lives under a sub-path.

On the phone: tap the big button and talk. Turn on **Hands-free** to keep the conversation going. On a computer, pick a voice from the list and tap **Test voice**. On Android, Chrome always speaks with the phone's own text-to-speech voice, so change it in the phone settings (search "Text-to-speech"); the page shows where. **New topic** starts a fresh Claude Code session. Keep the page open: Android switches the microphone off when the browser goes to the background. The screen stays awake by itself.

## Options

| flag | what it does |
|---|---|
| `--dir <folder>` | the project Claude Code works in (default: where you start it) |
| `--port 3411` | local port; Shuteye only listens on 127.0.0.1 |
| `--tunnel` | start cloudflared and print a phone link |
| `--full-powers` | let the voice session change things, after asking you first |
| `--claude <path>` | path to the `claude` binary |
| `--base /voice` | URL prefix when served behind your own proxy |
| `--trust-proxy` | use `X-Real-IP` for the lockout (only behind your own proxy, which must set it); with `--tunnel` Cloudflare's own header is used |
| `--pair` | print a new one-time pairing link for the running server |

State lives in `~/.shuteye/`: the key, the pairing token, the last session id, `history.md` (every spoken exchange, so you can read back what was said) and `deny.json`.

## Security, honestly

Whoever holds your paired phone (or the key) has your Claude Code session. The key sits in that browser's storage and is sent as a header on every call, so treat the phone like a password. After five wrong tries from one address (or fifty in all), wrong keys are answered with "too many tries" for an hour. A right key always works, and the key is 256 random bits, so guessing it is not practical. Run Shuteye on its own address (or port): any other script on the same origin could read the key.

**Read-only mode** (the default) runs Claude Code with `--restricted` and a fixed tool list (Read, Glob, Grep, WebSearch). Nothing that runs commands or code is available, your settings files cannot add tools back, and reads are confined to the project folder. It can read your project and search the web.

**Full-powers mode** runs Claude Code with `bypassPermissions`. The spoken rules make it announce each change and wait for "yes", and `deny.json` keeps secret files (SSH keys, cloud credentials, `.env`, your Claude login) away from the file tools. **Bash is not sandboxed in this mode**: a command like `cat ~/.ssh/id_rsa` would still work. Full powers is a decision about who holds your phone, not a sandbox. If you run it as a systemd service, `NoNewPrivileges=yes` and `InaccessiblePaths=` for your key folders raise the bar, but they are not a wall: if the same user can use sudo, cron, a user systemd manager, or can edit scripts that something else runs as root, a determined person with your phone can get around them. For real separation run Shuteye as its own user without sudo.

About `deny.json`: in Claude Code permission rules a path that starts with a single `/` is **relative to the settings file** and protects nothing on your disk. Use `~/` for your home folder and `//` for an absolute path. If you add a rule, test it with a harmless dummy file inside the real folder.

Each question is a normal Claude Code request and uses your plan or API credits like any other.

The listening is done by your browser: Chrome sends the audio to Google's speech service to turn it into text. Claude.ai connectors (Gmail, Drive and so on) are switched off in the voice session by `deny.json`.

## Limits

- Tested on Chrome for Android. Desktop Chrome should work the same way; Safari on iPhone is untested.
- One question at a time. Long jobs keep working; a soft beep every eight seconds tells you it is still thinking.
- It cannot see screenshots or send you files; it is a voice conversation.
- The voice session is separate from any Claude Code session you have open elsewhere. If both change the same files at once, they can collide.

## Tip

Shuteye is free. If it gives your eyes a rest, you can tip the developer in USDC on Arc or Base:

`0xD3d3d2F67D15592267f953CabF5eCd38635d6C10`

## Credits

Made by [APEX Faucet](https://apexfaucet.xyz/arc/), which gives away free USDC for gas on Arc. MIT licence.
