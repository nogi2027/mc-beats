type WebMcpJsonSchema = Record<string, unknown>;

type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: WebMcpJsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

type WebMcpRegistrationOptions = { signal?: AbortSignal };

interface ModelContextDraft {
  registerTool(tool: WebMcpTool, options?: WebMcpRegistrationOptions): void | Promise<void>;
}

interface Document {
  modelContext?: ModelContextDraft;
}
