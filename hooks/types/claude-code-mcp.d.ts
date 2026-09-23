// The inputs of the MCP tools this session had, from each server's tools/list
// inputSchema; written by `/plugin-types` (src/plugins/functionHooks/mcp-tool-types/mcp-tool-declarations.ts).
// Merges into the engine's ToolCallInput (types/ McpToolInputs) so
// `e.tool === "mcp__<server>__<tool>"` narrows to the tool's arguments.
// Regenerate rather than edit.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** Ask Gemini a synchronous read-only code question without creating a lane. Returns file and line evidence within 90 seconds. */
    mcp__cdx__ask: {
      question: string
      cd: string
    }
    /** Close a completed lane and archive its status. */
    mcp__cdx__close: {
      /** Lane name */
      lane: string
      /** Close without removing the worktree or branch; print manual cleanup commands */
      keepWorktree?: boolean
      /** Optional closing note */
      note?: string
    }
    /** Start a read-only consultation lane to analyze code and answer a question. */
    mcp__cdx__consult: {
      /** Name for the consultation lane */
      lane: string
      /** Question to investigate */
      question: string
      /** Execution engine */
      engine?: "gpt" | "gemini"
      /** Run consultation as supervisor */
      supervisor?: boolean
      /** Model alias or id */
      model?: string
      /** Reasoning effort */
      effort?: string
      /** Absolute path of the repository the lane runs in (required: the session directory follows the shell, so the tool never guesses); with worktree, the repository the worktree is cut from */
      cd: string
      /** Account name */
      account?: string
    }
    /** Diagnose plugin installation, engine accounts, and background workers. */
    mcp__cdx__doctor: {
      /** Attempt automated repairs */
      fix?: boolean
      /** Probe live engine credentials and rate limits */
      probe?: boolean
    }
    /** Return every owned event not yet delivered: the mod's buffer, then the feed. */
    mcp__cdx__events: {}
    /** Set or clear the verification gate command for a lane. */
    mcp__cdx__gate: {
      /** Lane name */
      lane: string
      /** New gate command to run */
      cmd?: string
      /** Clear existing gate command */
      clear?: boolean
    }
    /** Read content-bound acceptance proof for the latest work round. */
    "mcp__cdx__gate-receipt": {
      /** Lane name */
      lane: string
    }
    /** Read incoming messages sent to this session. */
    mcp__cdx__inbox: {
      /** Number of message lines to read */
      lines?: number
    }
    /** Launch a detached background job command beside lanes. */
    mcp__cdx__job: {
      /** Job name */
      name: string
      /** Shell command to run */
      cmd: string
      /** Explicit working directory for the job */
      cd: string
    }
    /** Terminate a running lane process immediately. */
    mcp__cdx__kill: {
      /** Lane name */
      lane: string
    }
    /** Commit a green lane, merge into its base, push, remove the worktree and branch, and close. Refuses dirty base checkouts and stale or red receipts. */
    mcp__cdx__land: {
      lane: string
    }
    /** Send a notification message to a session or lane. */
    mcp__cdx__msg: {
      /** Target session or lane */
      target: string
      /** Message body */
      text: string
    }
    /** List open questions across all lanes or for a specific lane. */
    mcp__cdx__questions: {
      /** Optional lane filter */
      lane?: string
    }
    /** Answer an open question asked by a lane. */
    mcp__cdx__reply: {
      /** Target lane name */
      lane: string
      /** Answer text */
      answer: string
      /** Optional question sequence id */
      id?: number | string
    }
    /** Read the final report written by a finished lane. */
    mcp__cdx__report: {
      /** Lane name */
      lane: string
    }
    /** Repair a failed gate or P1/P2 review on the same diff. New scope needs a fresh lane seeded from the report. */
    mcp__cdx__resume: {
      /** Name of the lane to resume */
      lane: string
      /** Fix instructions for the same diff */
      followUp: string
      /** Evidence being repaired */
      fix: "gate" | "review"
      /** Reasoning effort */
      effort?: string
      /** Maximum runtime in minutes */
      maxRuntime?: number
    }
    /** Start an independent code review lane. Two exclusive modes: intent reviews the working tree; uncommitted, base or commit chooses a Git diff target. Passing intent with a target flag is refused. */
    mcp__cdx__review: {
      /** Name for the review lane */
      lane: string
      /** Execution engine */
      engine?: "gpt" | "gemini"
      /** Model alias or id */
      model?: string
      /** Reasoning effort */
      effort?: string
      /** Absolute path of the repository the lane runs in (required: the session directory follows the shell, so the tool never guesses); with worktree, the repository the worktree is cut from */
      cd: string
      /** Review uncommitted changes */
      uncommitted?: boolean
      /** Base branch to compare against */
      base?: string
      /** Specific commit to review */
      commit?: string
      /** File path pattern scope */
      scope?: string
      /** Review intent or focus */
      intent?: string
    }
    /** Send steering instructions or a message to a running lane. */
    mcp__cdx__send: {
      /** Target lane name */
      lane: string
      /** Message text to deliver */
      text: string
    }
    /** Spawn a new cdx lane with a brief. The brief is delivered whole through stdin so quotes and newlines are safe; completion arrives as a [cdx] event. */
    mcp__cdx__spawn: {
      /** Name for the new lane */
      lane: string
      /** Task brief for the lane */
      brief: string
      /** Execution engine */
      engine?: "gpt" | "gemini"
      /** Model alias or id */
      model?: string
      /** Run lane as supervisor */
      supervisor?: boolean
      /** Absolute path of the repository the lane runs in (required: the session directory follows the shell, so the tool never guesses); with worktree, the repository the worktree is cut from */
      cd: string
      /** Worktree path or name */
      worktree?: string
      /** Verification command to run before reporting */
      gate?: string
      /** Setup command to run before starting work */
      pre?: string
      /** Reasoning effort */
      effort?: string
      /** Maximum runtime in minutes */
      maxRuntime?: number
      /** Account name */
      account?: string
      /** Additional directories */
      addDirs?: string[]
      /** Structured output JSON schema path */
      schema?: string
      /** Image paths to attach */
      images?: string[]
    }
    /** Show the status of active and recent cdx lanes. brief returns one line per running or unclosed lane plus running jobs; the default is the detailed block per lane. */
    mcp__cdx__status: {
      /** Include closed lanes */
      all?: boolean
      /** One line per lane and job, the same text as the session brief */
      brief?: boolean
    }
    /** Inspect the latest execution log lines for a running or finished lane. */
    mcp__cdx__tail: {
      /** Lane name */
      lane: string
      /** Number of lines to read */
      lines?: number
    }
    /** Claim ownership of a lane spawned by another session. */
    mcp__cdx__takeover: {
      /** Lane name or session to adopt */
      target: string
    }
    /** Report Codex and Gemini quota rows, observed burn, projected forfeiture and exhaustion, holds, and GPT account picks. json includes evidence and ledger totals; totals adds ledger totals to text. */
    mcp__cdx__usage: {
      /** Include all-time ledger totals in text. */
      totals?: boolean
      /** Machine-readable output instead of the text report. */
      json?: boolean
    }
    /** Create a doc, or apply several operations to one doc atomically. */
    mcp__claude_ai_Claude_Docs__batch: {
      batch?: unknown[]
      container?: {
        kind: string
        id?: string
        create?: {}
      }
      verbose?: boolean
      opId?: string
    }
    /** Create one object in a doc: a tab, its contents, a comment, an upload record. */
    mcp__claude_ai_Claude_Docs__create: {
      object: "file" | "node" | "utterance" | "enum" | "blob"
      engine?: string
      payload: {} | string
      container?: {
        kind: string
        id: string
        version?: string
      }
      verbose?: boolean
      opId?: string
      artifact?: string
    }
    /** Delete one object from a doc: a tab, its contents, a comment, an upload record. A doc keeps at least one tab (deleting its last refuses `last_tab`): to start over, rewrite that tab's contents with `update`, never delete and recreate the tab. */
    mcp__claude_ai_Claude_Docs__delete: {
      ref: {
        object: "project" | "file" | "node" | "utterance"
        id: string
      }
      engine?: string
      container?: {
        kind: string
        id: string
        version?: string
      }
      payload?: {} | string
      verbose?: boolean
      opId?: string
    }
    /** Export one tab inline as base64: pdf, docx, html, text, markdown or notion (Notion-flavored markdown, what notion-create-pages takes). To just keep the file in the doc's files, create a blob {from: {object: "file", id}, format} instead (no large result). */
    mcp__claude_ai_Claude_Docs__export: {
      container: {
        kind: string
        id: string
        version?: string
      }
      file: string
      format: "markdown" | "text" | "html" | "docx" | "pdf" | "notion"
      paper?: "letter" | "a4"
      maxBytes?: number
    }
    /** Docs guides: topic.instructions repeats the server instructions. Read it only if your client dropped them. Also topic.<name>, refusal.<code>. After a doc's birth → ["topic.index"]. */
    mcp__claude_ai_Claude_Docs__guide: {
      /** topic.<name> (instructions, index, editing, tabs, comments, charts, chart-definition, uploads, skill) or refusal.<code>; several per call is fine. */
      items?: unknown[]
    }
    /** List a tab's or a doc's comment history (threads, replies, resolves). */
    mcp__claude_ai_Claude_Docs__query: {
      container?: {
        kind: string
        id: string
        version?: string
      }
      object?: "utterance"
      payload?: {} | string
    }
    /** Read a doc (lists its tabs), a tab's contents, or a comment. A claude.ai/[code/]artifact/[<title>-]<id> link → `ref {"object":"project","id":"<id>"}` first; reads inside it take `container {"kind":"project","id":"<id>"}`. */
    mcp__claude_ai_Claude_Docs__read: {
      ref: {
        object: "project" | "file" | "node" | "utterance" | "enum" | "blob"
        id: string
      }
      engine?: string
      container?: {
        kind: string
        id: string
        version?: string
      }
      payload?: {} | string
    }
    /** Edit a tab's contents, rename a doc or tab, or change a stored value. */
    mcp__claude_ai_Claude_Docs__update: {
      ref: {
        object: "project" | "file" | "node" | "utterance" | "enum"
        id: string
      }
      engine?: string
      payload: {} | string
      container?: {
        kind: string
        id: string
        version?: string
      }
      verbose?: boolean
      opId?: string
      answering?: string
    }
    /** PRIMARY TOOL — call FIRST for almost any question OR before an edit: how does X work, architecture, a bug, where/what is X, surveying an area, or the symbols you are about to change. Returns the verbatim source of the relevant symbols grouped by file in ONE capped call (Read-equivalent — treat the shown source as already Read; do NOT re-open those files), plus the call path among them. Query can be a natural-language question OR a bag of symbol/file names. Usually the ONLY call you need — more accurate context, in far fewer tokens and round-trips than a search/Read/Grep loop. */
    mcp__codegraph__codegraph_explore: {
      /** Symbol names, file names, or short code terms to explore (e.g., "AuthService loginUser session-manager", "GraphTraverser BFS impact traversal.ts"). For a flow question, name the symbols spanning the flow (e.g. "mutateElement renderScene"). A natural-language question works too — no prior codegraph_search needed. */
      query: string
      /** Maximum number of files to include source code from (default: 12) */
      maxFiles?: number
      /** Absolute path to the project to query (or any directory inside it) — codegraph uses the nearest .codegraph/ index at or above that path. Omit to use this session's default project. Pass it to query a second codebase, or when the server root has no index of its own (e.g. a monorepo where only sub-projects are indexed, so there is no default project). */
      projectPath?: string
    }
    /** Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework. You must call 'Resolve Context7 Library ID' tool first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query. Do not call this tool more than 3 times per question. */
    "mcp__context7__query-docs": {
      /** Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'. */
      libraryId: string
      /** What to look up in the library's documentation, scoped to a single concept. Be specific and include relevant details, but keep each query to one topic — if the user's question spans multiple distinct concepts, make a separate call per concept instead of combining them, unless the question is about how the concepts interact. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad (too vague): 'auth' or 'hooks'. Bad (too broad): 'routing and auth and caching in Next.js'. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query. */
      query: string
    }
    /** Resolves a package/product name to a Context7-compatible library ID and returns matching libraries. You MUST call this function before 'Query Documentation' tool to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query. Each result includes: - Library ID: Context7-compatible identifier (format: /org/project) - Name: Library or package name - Description: Short summary - Code Snippets: Number of available code examples - Source Reputation: Authority indicator (High, Medium, Low, or Unknown) - Benchmark Score: Quality indicator (100 is the highest score) - Versions: List of versions if available. Use one of those versions if the user provides a version in their query. The format of the version is /org/project/version. For best results, select libraries based on name match, source reputation, snippet coverage, benchmark score, and relevance to your use case. Selection Process: 1. Analyze the query to understand what library/package the user is looking for 2. Return the most relevant match based on: - Name similarity to the query (exact matches prioritized) - Description relevance to the query's intent - Documentation coverage (prioritize libraries with higher Code Snippet counts) - Source reputation (consider libraries with High or Medium reputation more authoritative) - Benchmark Score: Quality indicator (100 is the highest score) Response Format: - Return the selected library ID in a clearly marked section - Provide a brief explanation for why this library was chosen - If multiple good matches exist, acknowledge this but proceed with the most relevant one - If no good matches exist, clearly state this and suggest query refinements For ambiguous queries, request clarification before proceeding with a best-guess match. IMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best result you have. */
    "mcp__context7__resolve-library-id": {
      /** What to look up in the library's documentation. This is used to rank library results by relevance to what the user is trying to accomplish. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query. */
      query: string
      /** Library name to search for and retrieve a Context7-compatible library ID. Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs', 'Customer.io' instead of 'customerio', 'Three.js' instead of 'threejs'. */
      libraryName: string
    }
  }
}
