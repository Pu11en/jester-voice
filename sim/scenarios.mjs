// These are behavioral examples, not generated model answers. Each check is
// evaluated after a complete turn against the real Conversation and OwnerRouter.
export const scenarios = [
  {
    id: "ambient-zoro",
    title: "Dormant room talk, guest, then Zoro status",
    steps: [
      { speaker: "owner", text: "I think Zoro did the audit.", expect: { silence: true, writes: 0, brain: 0 } },
      { speaker: "guest", text: "Hey Jester, what did Zoro do?", expect: { silence: true, writes: 0, brain: 0 } },
      { speaker: "owner", text: "Jester, what is Zoro doing?", expect: {
        says: ["zoro", "Drew's Audit", "reviewed"], writes: 0, brain: 0,
      } },
      { speaker: "owner", text: "What did it finish?", expect: {
        says: ["reviewed", "audit"], writes: 0,
      } },
      { speaker: "guest", text: "Let me tell you about dinner.", expect: { silence: true, writes: 0 } },
      { speaker: "owner", text: "Tell him to do the next page.", expect: { silence: true, writes: 0 } },
    ],
  },
  {
    id: "discuss-zoro",
    title: "Discuss Zoro's audit without assigning work",
    steps: [
      { speaker: "owner", text: "Hey Jester, help me figure out what we could do with Drew's audit. I mean Zoro.",
        expect: { says: ["zoro", "audit"], writes: 0 } },
      { speaker: "owner", text: "Let's talk through it first.", expect: { says: ["audit"], writes: 0 } },
    ],
  },
  {
    id: "jobs-draft",
    title: "Collect a Jobs/LinkedIn request across turns",
    steps: [
      { speaker: "owner", text: "Jester, open a session in Jobs.", expect: {
        says: ["what"], writes: 0, brain: 0,
      } },
      { speaker: "owner", text: "It's for LinkedIn. I have something to add.", expect: { writes: 0, brain: 0 } },
      { speaker: "owner", text: "Have it update my profile and publish it—actually, just review the profile and list suggested changes. Don't publish anything.",
        expect: { writes: 1, writeKind: "spawn", writeTarget: "Jobs", writeText: ["review", "profile", "Don't publish"],
          writeExcludes: ["update my profile", "publish it"], says: ["queued", "Jobs"], brain: 0 } },
    ],
  },
  {
    id: "one-turn-create",
    title: "A complete create request starts one session immediately",
    steps: [
      { speaker: "owner", text: "Jester, create a session in Jobs to review the LinkedIn profile.",
        expect: { writes: 1, writeKind: "spawn", writeTarget: "Jobs",
          writeText: ["review the LinkedIn profile"], says: ["queued", "Jobs"], brain: 0 } },
    ],
  },
  {
    id: "abandoned-create",
    title: "A Zoro status question cancels an unfinished Jobs request",
    steps: [
      { speaker: "owner", text: "Jester, open a session in Jobs.",
        expect: { writes: 0, says: ["what should"], brain: 0 } },
      { speaker: "owner", text: "Jester, what is Zoro doing?",
        expect: { writes: 0, says: ["zoro", "reviewed"], brain: 0 } },
      { speaker: "owner", text: "Tell it to review the login page.",
        expect: { writes: 1, writeKind: "spoken", writeTarget: "zoro",
          writeThreadId: "1553779983158349925", writeText: ["review the login page"], brain: 0 } },
    ],
  },
  {
    id: "abandoned-create-chat",
    title: "Unrelated conversation cancels an unfinished Jobs request",
    steps: [
      { speaker: "owner", text: "Jester, open a session in Jobs.",
        expect: { writes: 0, says: ["what should"], brain: 0 } },
      { speaker: "owner", text: "Could you tell me a joke?",
        expect: { writes: 0, brain: 1 } },
      { speaker: "owner", text: "Tell it to review the login page.",
        expect: { writes: 0, says: ["can't find"], brain: 0 } },
    ],
  },
  {
    id: "create-error",
    title: "A project lookup failure gives an answer and sends nothing",
    steps: [
      { speaker: "owner", text: "Jester, open a session in Jobs.",
        expect: { writes: 0, says: ["what should"], brain: 0 } },
      { speaker: "owner", text: "Have it review the profile.",
        expect: { writes: 0, says: ["can't reach"], brain: 0 } },
    ],
  },
  {
    id: "correct-target",
    title: "Final target and task win; exact-thread follow-up",
    steps: [
      { speaker: "owner", text: "Jester, and Frankie, we need to change the site—wait, Zoro, just review the login page and give me test ideas. Don't edit files.",
        expect: { writes: 1, writeKind: "spoken", writeTarget: "zoro", writeText: ["review", "login page", "Don't edit files"],
          writeThreadId: "1553779983158349925",
          writeExcludes: ["change the site"], says: ["posted", "zoro"], brain: 0 } },
      { speaker: "owner", text: "Tell him to include mobile login.", expect: {
        writes: 1, writeKind: "spoken", writeTarget: "zoro", writeText: ["mobile login"], says: ["posted", "zoro"], brain: 0,
        writeThreadId: "1553779983158349925",
      } },
    ],
  },
  {
    id: "recorded-jobs",
    title: "Replay the actual Jobs request from the first voice trial",
    steps: [
      { speaker: "owner", text: "Jester.", expect: { writes: 0 } },
      { speaker: "owner", text: "Uh could you make a new folder? Actually wait wait", expect: { writes: 0 } },
      { speaker: "owner", text: "There's a folder called LinkedIn or no, no, no, no.", expect: { writes: 0 } },
      { speaker: "owner", text: "It's inside jobs folder.", expect: { writes: 0 } },
      { speaker: "owner", text: "Uh yeah, open of a thread in the jobs folder.", expect: {
        says: ["what should"], writes: 0, brain: 0,
      } },
      { speaker: "owner", text: "And the session is gonna be about LinkedIn. I have something I'm gonna put in that session. Like I got from an email. It's like skills, but I don't know what it is, but it's something for LinkedIn.",
        expect: { says: ["go ahead"], writes: 0, brain: 0 } },
    ],
  },
  {
    id: "yo-zoro",
    title: "Yo Jester uses the same session route as Jester",
    steps: [
      { speaker: "owner", text: "Yo Jester, what is Zoro doing?", expect: {
        says: ["zoro", "Drew's Audit", "reviewed"], writes: 0, brain: 0,
      } },
    ],
  },
  {
    id: "natural-zoro",
    title: "Natural Zoro questions use checked EBI evidence",
    steps: [
      { speaker: "owner", text: "Jester, what is going on with Zoro?", expect: {
        says: ["zoro", "Drew's Audit", "reviewed"], writes: 0, brain: 0,
      } },
      { speaker: "owner", text: "Jester, help me with Zoro's audit", expect: {
        says: ["zoro", "audit"], writes: 0, brain: 0,
      } },
    ],
  },
  {
    id: "ambiguous-both",
    title: "Both without a named pair asks instead of guessing",
    steps: [
      { speaker: "owner", text: "Jester, when both finish, tell Frankie to check links.", expect: {
        says: ["which two"], writes: 0, groups: 0, brain: 0,
      } },
    ],
  },
  {
    id: "status-watch",
    title: "One requested update, then a two-session result watch and handoff",
    steps: [
      { speaker: "owner", text: "Jester, update me on my sessions.", expect: {
        says: ["zoro", "sanji", "task"], writes: 0, brain: 0,
      } },
      { speaker: "owner", text: "When Zoro and Sanji finish, tell me what I can test.", expect: {
        says: ["watch 2 sessions"], writes: 0, watches: 1, brain: 0,
      } },
      { speaker: "owner", text: "When both finish, tell Frankie to check the links.", expect: {
        says: ["both", "franky"], writes: 0, groups: 1, brain: 0,
      } },
    ],
  },
  {
    id: "quiet-modes",
    title: "Listen mode and leave block speech and actions",
    steps: [
      { speaker: "owner", text: "Jester, just listen.", expect: { silence: true, writes: 0, brain: 0, muted: true } },
      { speaker: "owner", text: "Jester, tell Zoro to deploy the site.", expect: { silence: true, writes: 0, brain: 0 } },
      { speaker: "owner", text: "Jester, talk again.", expect: { silence: true, writes: 0, brain: 0, muted: false } },
      { speaker: "owner", text: "Tell Zoro to deploy the site.", expect: { silence: true, writes: 0, brain: 0 } },
      { speaker: "owner", text: "Jester, leave.", expect: { silence: true, writes: 0, brain: 0, disconnected: true } },
    ],
  },
  {
    id: "dismiss-side-talk",
    title: "Guest side talk closes the exchange; dismissal works",
    steps: [
      { speaker: "owner", text: "Jester, hello.", expect: { says: ["hello"], writes: 0 } },
      { speaker: "guest", text: "What are we doing later?", expect: { silence: true, writes: 0 } },
      { speaker: "owner", text: "I think we'll get dinner.", expect: { silence: true, writes: 0, brain: 0 } },
      { speaker: "owner", text: "Jester, shut up, go away.", expect: {
        silence: true, writes: 0, brain: 0, disconnected: true,
      } },
    ],
  },
];
