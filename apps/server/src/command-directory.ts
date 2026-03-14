import type {
  CliCommandCategory,
  CliCommandDefinition
} from "@social/shared";

export const commandCategories: CliCommandCategory[] = [
  {
    id: "identity",
    label: "Identity",
    description: "Inspect or update the current CLI identity."
  },
  {
    id: "people",
    label: "People",
    description: "Browse users and manage friend relationships."
  },
  {
    id: "threads",
    label: "Threads",
    description: "Create chats, inspect them, and manage participants."
  },
  {
    id: "messages",
    label: "Messages",
    description: "Read, send, react to, and monitor thread activity."
  },
  {
    id: "apps",
    label: "Apps",
    description: "Create, inspect, generate, share, and mutate collaborative apps."
  },
  {
    id: "search",
    label: "Search",
    description: "Run layered keyword and semantic search inside a chat."
  },
  {
    id: "ai",
    label: "AI",
    description: "Summarize chats, ask questions, and discover useful commands."
  }
];

export const commandDefinitions: CliCommandDefinition[] = [
  {
    id: "whoami",
    categoryId: "identity",
    title: "Show current identity",
    usage: "social-cli whoami [--name \"<username>\"] [--kind user|ai] [--json]",
    summary: "Shows the CLI identity and the current snapshot counts.",
    examples: ["social-cli whoami --json"],
    intents: ["who am i", "current profile", "identity info"]
  },
  {
    id: "users-list",
    categoryId: "people",
    title: "List users",
    usage: "social-cli users list [--json]",
    summary: "Lists all visible users and whether they are friends.",
    examples: ["social-cli users list"],
    intents: ["see users", "directory", "browse people"]
  },
  {
    id: "friends-manage",
    categoryId: "people",
    title: "Manage friends",
    usage:
      "social-cli friends add --friend <agent-id> | social-cli friends remove --friend <agent-id>",
    summary: "Adds or removes a friend relationship.",
    examples: [
      "social-cli friends add --friend <agent-id>",
      "social-cli friends remove --friend <agent-id>"
    ],
    intents: ["add friend", "remove friend", "manage relationships"]
  },
  {
    id: "threads-list",
    categoryId: "threads",
    title: "List threads",
    usage: "social-cli threads list [--json]",
    summary: "Lists visible chats with their latest activity.",
    examples: ["social-cli threads list"],
    intents: ["see chats", "recent conversations", "list threads"]
  },
  {
    id: "threads-show",
    categoryId: "threads",
    title: "Show thread detail",
    usage: "social-cli threads show --thread <thread-id> [--json]",
    summary: "Shows a chat, its participants, summary, and messages.",
    examples: ["social-cli threads show --thread <thread-id>"],
    intents: ["inspect thread", "thread details", "chat info"]
  },
  {
    id: "threads-create",
    categoryId: "threads",
    title: "Create a thread",
    usage:
      "social-cli threads create --participants id1,id2 [--title \"Thread title\"] [--json]",
    summary: "Creates a new chat with one or more participants.",
    examples: ["social-cli threads create --participants user-a,user-b"],
    intents: ["start chat", "create conversation", "new thread"]
  },
  {
    id: "threads-participants",
    categoryId: "threads",
    title: "Manage participants",
    usage:
      "social-cli threads participants add|remove --thread <thread-id> --participants id1,id2 [--json]",
    summary: "Adds or removes participants from an existing chat.",
    examples: [
      "social-cli threads participants add --thread <thread-id> --participants user-c"
    ],
    intents: ["add people to chat", "remove people from chat", "participants"]
  },
  {
    id: "message-list",
    categoryId: "messages",
    title: "List messages",
    usage: "social-cli message list --thread <thread-id> [--json]",
    summary: "Lists the messages in a chat, including reactions.",
    examples: ["social-cli message list --thread <thread-id>"],
    intents: ["read messages", "show conversation", "message history"]
  },
  {
    id: "message-send",
    categoryId: "messages",
    title: "Send a message",
    usage:
      "social-cli message text --thread <thread-id> --text \"hello\" [--json]",
    summary: "Sends a plain text message to a chat.",
    examples: ["social-cli message text --thread <thread-id> --text \"hello\""],
    intents: ["send message", "post chat text", "write to thread"]
  },
  {
    id: "react",
    categoryId: "messages",
    title: "Toggle a reaction",
    usage:
      "social-cli react --thread <thread-id> --message <message-id> --emoji 👍 [--json]",
    summary: "Adds or removes a reaction on a message.",
    examples: [
      "social-cli react --thread <thread-id> --message <message-id> --emoji 👍"
    ],
    intents: ["react to message", "emoji reaction", "toggle reaction"]
  },
  {
    id: "apps-list-show",
    categoryId: "apps",
    title: "Inspect apps",
    usage:
      "social-cli apps list --thread <thread-id> [--json] | social-cli apps show --thread <thread-id> --app <app-id> [--json]",
    summary:
      "Lists apps in a chat or shows one app's source, value, and metadata.",
    examples: [
      "social-cli apps list --thread <thread-id>",
      "social-cli apps show --thread <thread-id> --app <app-id>"
    ],
    intents: ["list apps", "show app", "inspect app"]
  },
  {
    id: "apps-create-delete",
    categoryId: "apps",
    title: "Create or delete an app",
    usage:
      "social-cli apps create --thread <thread-id> [--name \"App\"] [--description \"Desc\"] [--source '{...}' | --source-file ./app.json5] [--json] | social-cli apps delete --thread <thread-id> --app <app-id> [--json]",
    summary:
      "Creates a collaborative app from source or deletes an existing one.",
    examples: [
      "social-cli apps create --thread <thread-id> --name \"Todo\" --source-file ./todo.json5",
      "social-cli apps delete --thread <thread-id> --app <app-id>"
    ],
    intents: ["create app", "new app", "delete app"]
  },
  {
    id: "apps-update",
    categoryId: "apps",
    title: "Update app metadata or source",
    usage:
      "social-cli apps meta --thread <thread-id> --app <app-id> [--name \"App\"] [--description \"Desc\"] [--json] | social-cli apps save --thread <thread-id> --app <app-id> [--source '{...}' | --source-file ./app.json5] [--json]",
    summary:
      "Renames an app, changes its description, or saves a new source definition.",
    examples: [
      "social-cli apps meta --thread <thread-id> --app <app-id> --name \"Planning board\"",
      "social-cli apps save --thread <thread-id> --app <app-id> --source-file ./planning-board.json5"
    ],
    intents: ["rename app", "update app source", "save app"]
  },
  {
    id: "apps-set-share",
    categoryId: "apps",
    title: "Update app values or share an app",
    usage:
      "social-cli apps set --thread <thread-id> --app <app-id> --path form.todos[0].done --value-json true [--json] | social-cli apps share --thread <thread-id> --app <app-id> [--json]",
    summary:
      "Mutates app state at a path or posts an app embed into the thread as a message.",
    examples: [
      "social-cli apps set --thread <thread-id> --app <app-id> --path form.name --value \"Alex\"",
      "social-cli apps share --thread <thread-id> --app <app-id>"
    ],
    intents: ["update app field", "change app value", "share app in chat"]
  },
  {
    id: "apps-generate",
    categoryId: "apps",
    title: "Generate an app with AI",
    usage:
      "social-cli apps generate --thread <thread-id> --prompt \"<goal>\" [--app <app-id>] [--apply] [--name \"App\"] [--description \"Desc\"] [--json]",
    summary:
      "Streams generated app source from AI and can optionally apply it to a new or existing collaborative app.",
    examples: [
      "social-cli apps generate --thread <thread-id> --prompt \"Build a simple project tracker\"",
      "social-cli apps generate --thread <thread-id> --app <app-id> --apply --prompt \"Turn this into a kanban board\""
    ],
    intents: ["generate app", "create app with ai", "update app with ai"]
  },
  {
    id: "watch",
    categoryId: "messages",
    title: "Watch live updates",
    usage: "social-cli watch [--thread <thread-id>] [--json]",
    summary: "Streams thread, message, and reaction updates from the server.",
    examples: ["social-cli watch --thread <thread-id>"],
    intents: ["live updates", "stream chat activity", "monitor thread"]
  },
  {
    id: "search-chat",
    categoryId: "search",
    title: "Search a chat",
    usage:
      "social-cli search chat --thread <thread-id> --query \"<search text>\" [--limit 10] [--json]",
    summary:
      "Runs layered exact, partial, and semantic search over chat messages.",
    examples: [
      "social-cli search chat --thread <thread-id> --query \"roadmap decision\""
    ],
    intents: ["find message", "semantic search", "search thread history"]
  },
  {
    id: "ai-summarize",
    categoryId: "ai",
    title: "Summarize a chat or context",
    usage:
      "social-cli ai summarize --thread <thread-id> | --text \"<context>\" [--paragraphs 2] [--json]",
    summary:
      "Uses OpenAI to summarize either a thread or an arbitrary block of context.",
    examples: [
      "social-cli ai summarize --thread <thread-id>",
      "social-cli ai summarize --text \"meeting notes here\""
    ],
    intents: ["summarize chat", "summarize text", "short recap"]
  },
  {
    id: "ai-ask",
    categoryId: "ai",
    title: "Ask about a chat",
    usage:
      "social-cli ai ask --prompt \"<question>\" [--thread <thread-id>] [--json]",
    summary:
      "Asks an AI model a question, optionally grounded in the selected chat.",
    examples: [
      "social-cli ai ask --thread <thread-id> --prompt \"What did we decide about launch timing?\""
    ],
    intents: ["ask ai", "question answering", "answer about thread"]
  },
  {
    id: "ai-commands",
    categoryId: "ai",
    title: "Recommend commands",
    usage:
      "social-cli ai commands --query \"<goal>\" [--limit 5] [--json] | social-cli ai directory [--json]",
    summary:
      "Recommends the most relevant CLI commands for a natural-language goal or lists the command categories.",
    examples: [
      "social-cli ai commands --query \"find old messages about onboarding\"",
      "social-cli ai directory"
    ],
    intents: ["what command should i use", "command directory", "recommend cli command"]
  }
];

export function buildCommandDocument(command: CliCommandDefinition): string {
  return [
    command.title,
    command.summary,
    command.usage,
    command.examples.join(" "),
    command.intents.join(" ")
  ]
    .join("\n")
    .trim();
}
