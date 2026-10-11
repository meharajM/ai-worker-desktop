# AI engineering demand: final shortlist and desktop recommendation

**Final research review:** 10 October 2026, second pass.
**Scope:** AI application and agent engineering; India, US, and selected international employers.
**Status:** market shortlist finalized. The app separately selected LangChain.js/LangGraph.js; M03 macOS fixture proof passed, while Windows, real model and full footprint checks remain open.

## 1. Final conclusions

1. **Python has the strongest broad AI-language hiring evidence.** Pair it with API development and SQL for employment breadth.
2. **LangChain and LangGraph are the strongest framework hiring family in the evidence reviewed.** Learn LangChain integrations and LangGraph state/approval/recovery concepts. The counts describe the ecosystem, predominantly Python; they do not establish a LangGraph.js-specific hiring rank.
3. **TypeScript plus React is a valuable AI product engineering path.** Current independent employers explicitly use Vercel AI SDK. Its overall hiring share cannot be ranked against LangGraph from the available data.
4. **Use LangChain.js/LangGraph.js for this application's AI layer.** This is the subsequent product decision, separate from the market ranking. Vercel AI SDK remains evidence of TypeScript hiring demand, not an app implementation candidate.
5. **Prioritize MCP/tool calling, retrieval, evaluations, tracing, and delivery skills alongside a framework.** The list below is our synthesis of evidence and product needs, not a measured global ranking of unlike technologies.

## 2. Evidence and dates

| Source | Observed evidence | What it establishes and what it does not |
| --- | --- | --- |
| [Lightcast's analysis for Stanford AI Index 2026](https://lightcast.io/resources/blog/stanford-ai-2026), US postings from 2025 | Python in 258,674 AI postings, nearly 30% above 2024; broadly defined agent-related skills in nearly 90,000 postings. | Broad language and agent-skill demand. Annual postings are not current vacancies. |
| [Stanford AI Index 2026, Economy chapter](https://hai.stanford.edu/assets/files/ai_index_report_2026_chapter_4_economy.pdf), US postings from 2024–2025 | LangGraph mentions increased from 194 to 4,294. | Independent growth corroboration; no exhaustive contemporary SDK comparison. The narrow “Agentic AI” label and broader agent-skill cluster have different counts. |
| [foundit 2025 India AI hiring report](https://www.foundit.in/career-advice/foundit-insights-tracker-dec-2025/), published January 2026 | Python in nearly 75% of AI roles; SQL/data engineering in over half. GenAI/LLMs grew 58% year over year; MLOps/model deployment grew 42%. | India platform evidence supports production-AI skills. Its projected 2026 growth is a forecast, not observed growth. |
| [foundit August 2026 tracker](https://www.foundit.in/career-advice/foundit-insights-tracker-august-2026/), published September 2026 | Overall hiring index down 10% year over year; IT functional hiring up 5%, while the IT software/services industry declined 11%. | Recent regional context is selective hiring. These categories differ; they do not measure AI-framework demand. |
| [Agentic Engineering Jobs framework comparison](https://agentic-engineering-jobs.com/ai-agent-frameworks-job-market-2026), published May 2026 | Five-framework ranking from 1,135 listings ingested March 31–May 22. Counts below. | Comparable mentions within one specialist board. Overlap and ingestion bias prevent interpreting them as global market share. |
| Public employer ATS feeds, checked 10 October 2026 | Explicit LangChain/LangGraph roles and independent AI SDK product stacks. Extracted observations saved in [the evidence file](./ai-hiring-round2-evidence.json). | Current qualitative corroboration. Selected employers are not representative; keyword presence is not necessarily a requirement. |

Two broader sources support product engineering without ranking AI frameworks. The [Stack Overflow 2026 technology survey](https://survey.stackoverflow.co/2026/technology/data) reports TypeScript use at 43.8%, React at 41.5%, PostgreSQL at 57.9%, and Docker at 59.1%; each question has a different respondent base. These are self-reported adoption figures. The [CoderPad 2026 hiring survey](https://coderpad.io/survey-reports/coderpad-state-of-tech-hiring-2026/) reports hiring intentions for full-stack, backend, and AI/ML roles at 49%, 46%, and 35%; its mixed respondent survey is not a vacancy census.

## 3. Final tech priority list

Priorities apply to someone building employable AI applications. Confidence describes the evidence reviewed, not a calculated score.

| Priority | Technology or capability | Demand assessment | Use in AI-Worker Desktop |
| --- | --- | --- | --- |
| Core | **Python + API development/FastAPI** | Strong broad AI evidence; FastAPI appears in direct agent roles, but its share was not measured. | Learn for AI careers and optional integrations. Do not bundle a Python service in the core app. |
| Core | **LangChain + LangGraph** | Strongest sampled framework family, corroborated by enterprise ads and annual LangGraph growth. | Selected renderer AI stack: one-node chat first, bounded native-broker tool graph later. |
| Core | **TypeScript + React**; Node.js for service-side roles | Strong product-engineering signal from surveys and direct employers. | Keep the React/TypeScript UI. Node remains development tooling or an explicitly optional integration runtime. |
| Core | **SQL + PostgreSQL** | Strong data-skill evidence; PostgreSQL appears in product stacks and the adoption survey. | Transfer SQL skills to the local SQLite/rusqlite journal. Do not ship PostgreSQL. |
| Production | **Docker, CI/CD, AWS/Azure/GCP fundamentals** | Repeated in employer ads and production-AI evidence. No comparative cloud-provider ranking established. | Development, release, and career skills; no cloud or Docker dependency for offline core use. |
| Production | **MCP, structured tool calling, JSON Schema, human approval** | Direct evidence at Scalar, Nextdata, and Encora; useful across frameworks. | Official Rust MCP SDK (`rmcp`) and native ToolBroker; Rust validates model arguments and approval bindings. |
| Production | **RAG, embeddings, retrieval; LlamaIndex when needed** | Retrieval roles and LlamaIndex's sampled rank provide clear evidence. No vector-database winner established. | Defer indexing and broad ingestion until workspace search is a requirement. |
| Production | **Evaluations, tracing, reliability, cancellation and recovery** | Recurring responsibilities in direct agent-engineering roles. | Task diagnostics and evaluation fixtures when their implementation cards require them. Keep core use offline. |
| TypeScript specialization | **Vercel AI SDK Core** | Verified independent hiring/product-stack mentions; no comparable aggregate rank. | Market background only; the app uses LangChain.js/LangGraph.js. |
| Model engineering specialization | **PyTorch + Hugging Face tooling** | Present in model-focused roles; a different specialization from UI/tool-loop engineering. | Optional learning/development tools. Local inference remains the planned native llama.cpp runtime. |

Employer mentions of LangSmith do not make its hosted service an open-source/offline dependency. OpenTelemetry or an open-source tracing product can be evaluated later if required; this research does not rank observability vendors or authorize adding one.

## 4. Framework demand ranking: the comparable cohort

| Rank in the specialist cohort | Framework | Listings mentioning it | Development decision |
| --- | --- | ---: | --- |
| 1 | **LangChain** | **392** | Highest sampled name recognition; useful integration knowledge. |
| 2 | **LangGraph, Python/JS ecosystem** | **256** | First framework to prioritize for stateful orchestration skills. |
| 3 | **LlamaIndex** | **150** | Retrieval specialization; defer for initial scope. |
| 4 | **CrewAI** | **106** | Multi-agent specialization; defer for v1. |
| 5 | **AutoGen** | **74** | Historical demand; avoid a new implementation. |

Source: [published counts and methodology](https://agentic-engineering-jobs.com/ai-agent-frameworks-job-market-2026). Mentions overlap. Python appears in 91–96% of these cohorts and TypeScript in 18–26%; ecosystem counts cannot be assigned to JS packages. This is a dated cohort, not vacancies today.

**Vercel AI SDK is outside this comparable ranking.** Independent employer adoption supports it as a TypeScript choice; assigning it a sixth-place or third-place market rank would be misleading.

## 5. Direct employer evidence from the second pass

| Employer and source | What the role actually says | Interpretation |
| --- | --- | --- |
| [Accenture, Hyderabad: AI Infrastructure Architect](https://www.accenture.com/us-en/careers/jobdetails?id=ATCI-5636879-S2034608_en) | LangChain/LangGraph agents, mandatory Python, preferred REST/FastAPI, RAG and evaluation knowledge. | Direct India demand. The site's US navigation does not change its stated Hyderabad location. |
| [Wipro: GCP Gen AI Architect](https://careers.wipro.com/job/GCP-Gen-AI-Architect/203038-en_US/) | Python, SQL, RAG and framework alternatives including LangChain, LangGraph and LlamaIndex. | Enterprise corroboration. Irving/Jacksonville, US; not India evidence. |
| [Focused: Senior Agent Engineer](https://job-boards.greenhouse.io/focused/jobs/7998202003) | Python, LangChain/LangGraph, LangSmith, FastAPI and React. | Direct framework/full-stack demand; location copies collapsed by employer/title in our extraction. |
| [Encora/Coforge: Mid AI Engineer](https://job-boards.greenhouse.io/encora10/jobs/5228408007) | Python, RAG, LangChain/LangGraph, LlamaIndex and evaluation. | Another employer corroborating agent/data integration work. |
| [Nextdata: Forward Deployed Engineer](https://jobs.ashbyhq.com/nextdata/4feeb725-13e9-440b-984b-b173f943317b) | Python/SQL, RAG, MCP, LangChain/LangGraph and human review. | Integration and approval skills alongside orchestration. |
| [Remy: Founding AI/ML Engineer](https://jobs.ashbyhq.com/withremy/2bdde95a-620f-40b9-85dc-036c19d8bd1c) | Published stack includes TypeScript, Python, Vercel AI SDK, Hugging Face, RAG, AWS, Node.js and Docker. | Independent SDK adoption in an AI engineering role; verified in its public Ashby feed. |
| [Scalar: Senior Fullstack Engineer](https://jobs.ashbyhq.com/scalar/aa017463-43c4-407c-b6c9-b59076f01d82) and [Founding Solutions Engineer](https://jobs.ashbyhq.com/scalar/274bf7b1-be2a-45e4-9910-eb9bbced8366) | Agent Scalar uses Vercel AI SDK and MCP SDK. Relevant hands-on experience is a plus in the solutions role. | Independent product-stack evidence; not proof that prior SDK expertise is mandatory. |
| [Esper: Staff Software Engineer](https://jobs.lever.co/esper/20b2bfef-77c2-4e65-89b8-f3ef39d4ee32) | LangGraph, Vercel AI SDK, PydanticAI and OpenAI Agents SDK are alternative bonus experience. | Genuine but weaker evidence; not four required skills. |

### Method and exclusions

- Queried 11 selected public Ashby, Greenhouse and Lever employer feeds. Nine responded successfully; Vibiz and Downtown Music feeds failed. This is a convenience sample, including employers surfaced by framework searches.
- A broad description keyword pass selected 62 employer/title groups, including corporate boilerplate and general engineering roles. It is **not an AI-job count**. Narrowing to AI/ML/agent/LLM/GenAI words in titles left 16 groups at four employers.
- Saved those 16 plus four explicitly identified product/integration roles at Scalar, Esper and Nextdata: **20 selected employer/title groups at six employers**. Public-feed URLs and collected description hashes accompany extracted skills. Full copyrighted descriptions are not retained.
- Heavy employer concentration and manual supplementation make percentage comparisons inappropriate. Employer/title deduplication can merge distinct openings; use the extraction as qualitative corroboration.
- Excluded cached SDK ads from Owner and August Health absent from live feeds. IconicShift's feed returned no jobs. An earlier Downtown Music page was readable, but the final retrieval returned 404 and its API failed; exclude it from live evidence. Earlier Wipro Bengaluru and Cognizant Bengaluru ads were closed/unavailable, so they are not used as live India evidence.
- Reviewed the Buildagentic tracker and methodology, but excluded its counts because the seeded/synced data and counting denominators were insufficiently clear. GitHub stars, package downloads and search-result totals are not hiring counts.
- Feed presence/page accessibility supports the snapshot, not a guarantee that an employer is interviewing or a role will remain open.

## 6. Candidate SDKs: final disposition

| Candidate | What it adds | Final disposition for this app |
| --- | --- | --- |
| **AI SDK Core** | TypeScript provider, streaming, structured-output and bounded tool-loop mechanics. | Historical candidate; the app selected LangChain.js/LangGraph.js instead. Do not extend its proof harness. |
| **LangChain.js + LangGraph.js** | Provider/messages plus an explicit in-process bounded graph. | Selected app stack behind `IAgentClient`; no hosted service or durable graph checkpointer. |
| **LlamaIndex** | Retrieval/data ingestion and workflows. | Defer until corpus retrieval is needed. |
| **CrewAI** | Python crews and multi-agent workflows. | Defer; v1 excludes automatic subagents and a required Python runtime. |
| **Microsoft Agent Framework** | Python/.NET agent/workflow SDK; successor direction for AutoGen/Semantic Kernel. | Consider for Python/.NET enterprise work. Official 1.0 release status does not establish demand equal to AutoGen's historical count. |
| **Mastra** | Fuller TypeScript agent/workflow/memory/MCP framework. | Defer; the app owns approvals/persistence. Its license excludes specified Enterprise directories. |
| **PydanticAI, Google ADK, OpenAI Agents SDK** | Other typed/provider-oriented stacks. | No sufficiently comparable hiring evidence here establishes a top-market rank. Esper's alternatives do not establish one. |
| **Rig** | Rust provider and typed-tool abstractions. | Historical alternative; any architecture switch requires a new reviewed decision. |

Current documentation was checked through Context7 for [LangGraph JavaScript](https://docs.langchain.com/oss/javascript/langgraph/overview) and [AI SDK](https://ai-sdk.dev/docs/ai-sdk-core/overview). Supporting primary documentation: [AI SDK OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers), [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [LlamaIndex workflows](https://developers.llamaindex.ai/python/llamaagents/workflows/), [CrewAI agents](https://docs.crewai.com/core-concepts/Agents), [Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview) and [1.0 announcement](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/), [Mastra docs](https://mastra.ai/docs/agents/overview) and [license](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md), [Rig](https://docs.rs/rig/latest/rig/).

LangGraph checkpointing does not make external actions exactly-once. Its interrupt documentation says a resumed node runs again; side effects before the interrupt can repeat. The native operation journal and exact proposal approval remain necessary regardless of framework.

## 7. Final development recommendation

Continue with the planned stack:

- **React + TypeScript + Vite** for bundled offline assets.
- **LangChain.js + LangGraph.js** behind `IAgentClient`, with the bounded local transport adapter and later native ToolBroker routing.
- **Tauri 2 + Rust + official rmcp** for lifecycle, permissions, workspace/file operations, confirmed CLI actions and curated MCP sessions.
- **SQLite/rusqlite through `local-operation-journal`** for operation state/recovery, with the reusable TypeScript bridge.
- **One pinned llama.cpp server/profile** for local inference, with model footprint reported separately.

The repo contains Tauri scaffolding, React assets and an isolated LangChain/LangGraph proof harness. [M03's report](./stack-proof.md) records 11/11 fixture checks in macOS WKWebView, including native tool turns, history and cancellation. WebView2, real GGUF/runtime behavior and complete production footprint remain unproven. A failed gate requires a reviewed architecture decision. Do not bundle Python, a Node server, a workflow service or an additional framework for market keywords.

Exact package/model licenses and transitive notices remain a release check; an open-source SDK does not establish that every hosted service, add-on or model is open source. No dependency, implementation test, build or footprint measurement was added in this research pass.
