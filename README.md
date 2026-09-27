# Jester Voice

Real-time conversational voice interface for the EBI agent system, designed to run inside Discord voice channels.

## Goal

Join a Discord voice channel and talk naturally with Jester. Jester listens continuously, responds with low-latency speech, supports interruption/barge-in, and delegates real work to the existing EBI backend rather than replacing it.

## Architecture

```text
User in Discord Voice
        <->
Jester Discord Voice Bot
        <->
OpenAI GPT-Live / realtime voice session
        <->
EBI adapter
        <->
Existing EBI agents / tools / projects
```

This is intentionally a new service. Do not turn the existing `ebi-agent-chat-relay` Whisper recorder into the conversational bot. The existing recorder can remain unchanged.

## Secrets

The intended local configuration is only:

```env
DISCORD_TOKEN=
OPENAI_API_KEY=
```

Never commit either value. `.env` must remain ignored.

## V1 behavior

- Connect to Discord and join/leave a voice channel.
- Stream the user's Discord audio into a persistent OpenAI live voice session.
- Stream generated speech back into Discord.
- Support natural interruption/barge-in.
- Maintain one conversational session per active voice context.
- Expose a clean EBI delegation boundary for tasks that require agents/tools/projects.
- Reconnect safely when Discord or OpenAI connections drop.
- Keep useful logs without logging secrets.

Suggested control commands: `/join`, `/leave`, `/mute`, `/reset`, `/status`, `/project`.

## Important Discord constraint

Modern Discord voice bots must account for Discord's current encrypted voice/DAVE requirements. Do not select or pin a Discord voice dependency until current DAVE compatibility has been verified.

## Repository status

This repository begins as the clean handoff for the new voice service. See `HANDOFF.md` and `ARCHITECTURE.md` before implementation.
