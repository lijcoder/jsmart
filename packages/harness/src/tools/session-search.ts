import type { AgentTool } from "@jsmart/jsmart-agent-core";
import type { MemoryManager } from "@jsmart/jsmart-memory";
import { Type } from "@sinclair/typebox";

const sessionSearchSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description: "搜索关键词。支持中文和英文。用 OR 连接多个关键词以获得更广的召回。不填则返回最近会话。",
		}),
	),
	from: Type.Optional(
		Type.String({
			description:
				"ISO 8601 起始日期，如 '2025-06-01'。只搜索此日期及之后活跃的会话。用户说'上周'时转换为上周一的日期。",
		}),
	),
	to: Type.Optional(
		Type.String({
			description: "ISO 8601 结束日期，如 '2025-06-10'。只搜索此日期及之前活跃的会话。",
		}),
	),
	roleFilter: Type.Optional(
		Type.String({
			description: "只搜索特定角色的消息，如 'user,assistant' 跳过工具输出",
		}),
	),
	maxResults: Type.Optional(
		Type.Integer({
			description: "最大返回会话数（默认 3，最大 5）",
			default: 3,
		}),
	),
});

export function createSessionSearchTool(manager: MemoryManager): AgentTool<typeof sessionSearchSchema> {
	return {
		name: "session_search",
		label: "Session Search",
		description: `搜索历史会话。两种模式：1) 无关键词 - 浏览最近会话（零 LLM 成本）；2) 有关键词 - 全文搜索历史对话。

使用场景：用户说"我们之前做过这个"、"上次怎么修的"、"还记得吗"、"上周做了什么"。

**时间范围 —— 你需要自行计算 ISO 8601 日期：**
- 用户说"最近一周" → from = 7 天前的日期，如 "${new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)}"
- 用户说"三月份" → from = "2025-03-01", to = "2025-03-31"
- 用户说"上周" → from = 上周一的日期，to = 上周日的日期
- 不指定时间 → 不传 from/to，搜索全部历史

搜索语法：关键词用 OR 连接以扩大召回（如 'docker OR deploy OR error'），短语用引号精确匹配（如 "port binding"），前缀通配（如 deploy*）。`,
		parameters: sessionSearchSchema,
		execute: async (_toolCallId, params) => {
			const opts = {
				query: params.query,
				from: params.from,
				to: params.to,
				maxResults: params.maxResults ?? 3,
				roleFilter: params.roleFilter,
			};

			const results = params.query ? await manager.sessionSearchAsync(opts) : manager.sessionSearch(opts);

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: params.query
								? `未找到匹配 "${params.query}" 的会话。尝试用更短的关键词或 OR 连接。`
								: "没有找到最近的会话。",
						},
					],
					details: [],
				};
			}

			const range = params.from || params.to ? `（${params.from ?? "..."} ~ ${params.to ?? "..."}）` : "";
			const mode = params.query ? "keyword search" : "recent sessions";
			const text = [
				`找到 ${results.length} 个相关会话（${mode}）${range}：`,
				"",
				...results.map((r) => {
					const scoreStr = r.score > 0 ? `  ·  相关性: ${(r.score * 100).toFixed(0)}%` : "";
					const summaryStr = r.summary ? `\n\n**摘要：** ${r.summary}` : "";
					return `### ${r.title || r.sessionId.slice(0, 8)}${scoreStr}
**时间：** ${r.startedAt}  **来源：** ${r.source}  **模型：** ${r.model}
> ${r.snippet}${summaryStr}`;
				}),
			].join("\n");

			return { content: [{ type: "text", text }], details: results };
		},
	};
}
