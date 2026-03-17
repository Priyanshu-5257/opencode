import { Tool } from "./tool"
import DESCRIPTION from "./auto-task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"

const parameters = z.object({
    description: z.string().describe("A short (3-5 words) description of the task"),
    prompt: z.string().describe("The task for the worker agent to perform"),
    worker_agent: z.string().default("general").describe("The type of specialized agent to use for this task (default 'general')"),
    expert_persona: z.string().describe("The dynamically generated persona system prompt for the expert subagent to use when reviewing the worker's output (e.g. 'You are an MIT Math Postdoc...')"),
    success_criteria: z.string().describe("Specific criteria that the expert will use to evaluate if the loop should terminate."),
    max_iterations: z.number().int().min(1).max(50).default(5).describe("Maximum number of iterations allowed before forcing a stop"),
})

export const AutoTaskTool = Tool.define("auto-task", async (ctx) => {
    return {
        description: DESCRIPTION,
        parameters,
        async execute(params: z.infer<typeof parameters>, ctx) {
            const config = await Config.get()

            if (!ctx.extra?.bypassAgentCheck) {
                await ctx.ask({
                    permission: "task", // Require same permission level as task
                    patterns: [params.worker_agent, "expert"],
                    always: ["*"],
                    metadata: {
                        description: params.description,
                        subagent_type: params.worker_agent,
                    },
                })
            }

            const workerAgent = await Agent.get(params.worker_agent)
            if (!workerAgent) throw new Error(`Unknown agent type: ${params.worker_agent} is not a valid agent type`)

            const expertAgent = await Agent.get("expert")
            if (!expertAgent) throw new Error(`Expert agent is missing from configuration`)

            // Create two separate sessions: one for the worker, one for the expert
            const workerSession = await Session.create({
                parentID: ctx.sessionID,
                title: params.description + ` (@${workerAgent.name} worker)`,
                permission: [
                    { permission: "todowrite", pattern: "*", action: "deny" },
                    { permission: "todoread", pattern: "*", action: "deny" },
                    { permission: "task", pattern: "*", action: "deny" },
                    { permission: "auto-task", pattern: "*", action: "deny" },
                    ...(config.experimental?.primary_tools?.map((t) => ({ pattern: "*", action: "allow" as const, permission: t })) ?? []),
                ],
            })

            const expertSession = await Session.create({
                parentID: ctx.sessionID,
                title: params.description + ` (@expert reviewer)`,
                permission: [
                    { permission: "*", pattern: "*", action: "deny" }, // Expert should not use tools
                ],
            })

            const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
            if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

            const workerModel = workerAgent.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID }
            const expertModel = expertAgent.model ?? workerModel

            ctx.metadata({
                title: params.description,
                metadata: { workerSessionId: workerSession.id, expertSessionId: expertSession.id },
            })

            function cancel() {
                SessionPrompt.cancel(workerSession.id)
                SessionPrompt.cancel(expertSession.id)
            }
            ctx.abort.addEventListener("abort", cancel)
            using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

            let iteration = 0
            let currentPrompt = params.prompt
            let finalWorkerResult = ""
            let successReached = false
            let expertFeedback = ""

            while (iteration < params.max_iterations && !successReached) {
                iteration++
                console.log(`\n--- [Auto-Task] Iteration ${iteration}/${params.max_iterations} ---`)

                // 1. Worker Execution
                const workerMessageID = MessageID.ascending()
                const workerPromptParts = await SessionPrompt.resolvePromptParts(currentPrompt)

                const workerResult = await SessionPrompt.prompt({
                    messageID: workerMessageID,
                    sessionID: workerSession.id,
                    model: { modelID: workerModel.modelID, providerID: workerModel.providerID },
                    agent: workerAgent.name,
                    tools: {
                        todowrite: false, todoread: false, task: false, "auto-task": false,
                        ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
                    },
                    parts: workerPromptParts,
                })
                finalWorkerResult = workerResult.parts.findLast((x) => x.type === "text")?.text ?? ""

                // 2. Expert Review
                const expertMessageID = MessageID.ascending()
                const expertPrompt = `SYSTEM (Persona Context): ${params.expert_persona}\n\n` +
                    `The worker agent just completed an iteration with the following final output:\n<worker_output>\n${finalWorkerResult}\n</worker_output>\n\n` +
                    `Your job is to evaluate if this output meets the success criteria:\n<success_criteria>\n${params.success_criteria}\n</success_criteria>\n\n` +
                    `If the success criteria are fully met, reply strictly with ONLY the word "SUCCESS". ` +
                    `If they are not met, provide detailed feedback and the next specific step or prompt the worker should take to continue.`

                const expertPromptParts = await SessionPrompt.resolvePromptParts(expertPrompt)

                const expertEval = await SessionPrompt.prompt({
                    messageID: expertMessageID,
                    sessionID: expertSession.id,
                    model: { modelID: expertModel.modelID, providerID: expertModel.providerID },
                    agent: expertAgent.name,
                    tools: {}, // Expert uses no tools
                    parts: expertPromptParts,
                })
                expertFeedback = expertEval.parts.findLast((x) => x.type === "text")?.text ?? ""

                // 3. Evaluate Loop
                if (expertFeedback.trim() === "SUCCESS") {
                    successReached = true
                    break
                }

                // Pass expert feedback back to worker next loop
                currentPrompt = `The expert reviewer provided the following feedback on your last attempt:\n<expert_feedback>\n${expertFeedback}\n</expert_feedback>\nPlease continue working to solve the objective based on this feedback.`
            }

            const output = [
                `auto_task complete: Success Criteria Reached? ${successReached} (Iterations: ${iteration})`,
                "",
                "<final_worker_result>",
                finalWorkerResult,
                "</final_worker_result>",
                ...(successReached ? [] : [
                    "<final_expert_feedback>",
                    expertFeedback,
                    "</final_expert_feedback>",
                ])
            ].join("\n")

            return {
                title: params.description,
                metadata: { workerSessionId: workerSession.id, model: workerModel },
                output,
            }
        },
    }
})
