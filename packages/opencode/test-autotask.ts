import { Instance } from "./src/project/instance";
import { ToolRegistry } from "./src/tool/registry";
import { AutoTaskTool } from "./src/tool/auto-task";

async function main() {
    await Instance.provide({
        directory: process.cwd(),
        async fn() {
            const tool = await AutoTaskTool.init({});

            const { Database } = await import("./src/storage/db");
            const { MessageTable } = await import("./src/session/session.sql");
            const { Session } = await import("./src/session");
            const { MessageID } = await import("./src/session/schema");

            const session = await Session.create({
                title: "Test Session",
                permission: [],
            });

            const sid = session.id;
            const mid = MessageID.ascending();

            // Mock context
            const ctx: any = {
                sessionID: sid,
                messageID: mid,
                abort: new AbortController().signal,
                metadata: () => { },
                extra: { bypassAgentCheck: true }
            };

            Database.use((db) => {
                db.insert(MessageTable).values({
                    id: mid,
                    session_id: sid,
                    time_created: Date.now(),
                    data: {
                        role: "assistant",
                        id: mid,
                        modelID: "mock-model",
                        providerID: "mock-provider"
                    } as any
                }).execute()
            });

            console.log("Starting AutoTask evaluation...");
            const result = await tool.execute({
                description: "Test Loop",
                prompt: "Output the phrase 'magic_word'",
                worker_agent: "general",
                expert_persona: "You are a validator. If the worker output contains 'magic_word', output SUCCESS.",
                success_criteria: "Must contain 'magic_word'",
                max_iterations: 3
            }, ctx);

            console.log("Result:", result.output);
        }
    });
}
main().catch(console.error);
