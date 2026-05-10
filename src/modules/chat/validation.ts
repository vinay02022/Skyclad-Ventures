import { z } from "zod";

// Validation lives next to the route, not in a shared schemas folder, because
// nothing else in the codebase needs to validate this shape. Keeping it
// scoped also means changes to the chat contract are one focused diff.
export const ChatRequestSchema = z.object({
  model_class: z.enum(["cheap", "balanced", "premium"]),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1, "message content cannot be empty").max(50_000),
      }),
    )
    .min(1, "messages must contain at least one message")
    .max(100, "too many messages in a single request"),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional().default(0),
  max_tokens: z.number().int().positive().max(8192).optional().default(512),
  // Optional escape hatch for testing / debugging. The router (Phase 4) will
  // ignore this and pick by cost; for Phase 3 it's how the client can pin a
  // mock provider to exercise specific code paths.
  provider: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
});

export type ParsedChatRequest = z.infer<typeof ChatRequestSchema>;
