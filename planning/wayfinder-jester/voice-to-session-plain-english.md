# How Jester should hand work to your sessions

## What talking to Jester should feel like

- ✅ You say something like, **“Jester, tell Zoro to fix the login bug, and run the tests.”** You can pause, correct yourself, or add details before you finish.
- ⏳ Jester identifies the right live Zoro session, waits for your full thought, and sends **one task** to it. Zoro gets an instruction with the same authority as if you had typed it in Zoro's thread.
- ⏳ Jester tells you which session accepted the task. Zoro works in its normal project environment. Jester can later tell you when it finished, failed, or needs you.
- ⏳ While you're already talking with Jester, **“Zoro, also check the mobile login”** can go to the same session. After a lull, say **“Jester”** to start again. In **“just listen”** mode, session instructions are recorded but never sent.

## What choosing A means

- ✅ Jester is your voice interface. **Zoro, Nami, and your other EBI sessions do the file, browser, command, and project work.** This keeps the hands-free power of typing a task to them.
- ✅ Jester can read narrow session status and history so it can answer **“What is Zoro doing?”** without asking a new AI worker to guess.
- ⚠️ Jester itself cannot see your screen or independently inspect a project. It must use the real session's report before claiming that work is done.
- ⚠️ Guests can chat with Jester, but controlling your work sessions needs an explicit grant from you and a matching permission check in EBI.

## Holes I found in today's connection

- ⚠️ The old voice bot waited ten seconds after speech and sent a near-literal transcript. That is why a long, corrected thought could feel split or late. Jester needs to wait for the complete thought and send it once.
- ⚠️ Today's EBI voice endpoint accepts only about **4,000 characters**. It says “delivered” before the message is actually posted or the worker starts, and it has no safe retry ID. Jester must preserve long requests, report **accepted versus actually running**, and avoid accidentally sending a task twice.
- ⚠️ A new session can start with your task, but today's EBI API cannot set its requested AI model in the same step. If you ask for a specific model, Jester must set it before that first task starts or explain the limitation.
- ⚠️ Today's EBI API cannot reliably report every failure or stop a turn cleanly, and it does not yet enforce guest grants. Those are build tasks, alongside exact tag matching and safe recovery after a restart.

## The next behavior to settle

- ⏳ **What exact words should Zoro receive?** My recommendation is that Jester turns your speech into one clean, faithful prompt: keep your details and final corrections, drop filler, add no new goals, and send it when your intent and target are clear.
- ⏳ Your exact recognized speech still belongs in the room transcript, so you can see what was heard. You can ask Jester to read back or revise a task when you want; the recommended default avoids a readback ritual for every request.
