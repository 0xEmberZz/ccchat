/**
 * Hub HTTP API 客户端
 * 用于通过 HTTP 提交任务（走 TG 审批流程）
 */

export interface HttpClientConfig {
  readonly hubApiUrl: string
  readonly token: string
}

interface SubmitTaskResponse {
  readonly taskId: string
  readonly status: string
  readonly message: string
}

interface TaskStatusResponse {
  readonly taskId: string
  readonly status: string
  readonly from: string
  readonly to: string
  readonly content: string
  readonly result?: string
  readonly createdAt: string
  readonly completedAt?: string
}

export class HubHttpClient {
  private readonly config: HttpClientConfig

  constructor(config: HttpClientConfig) {
    this.config = config
  }

  /** 提交任务（走 TG 审批流程） */
  async submitTask(to: string, content: string): Promise<SubmitTaskResponse> {
    const resp = await fetch(`${this.config.hubApiUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.token}`,
      },
      body: JSON.stringify({ to, content }),
    })

    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`HTTP ${resp.status}: ${body}`)
    }

    return (await resp.json()) as SubmitTaskResponse
  }

  /** 查询任务状态 */
  async getTaskStatus(taskId: string): Promise<TaskStatusResponse> {
    const resp = await fetch(`${this.config.hubApiUrl}/api/tasks/${taskId}`, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
      },
    })

    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`HTTP ${resp.status}: ${body}`)
    }

    return (await resp.json()) as TaskStatusResponse
  }

  /** 列出在线 Agent */
  async listAgents(): Promise<ReadonlyArray<{ readonly name: string; readonly status: string }>> {
    const resp = await fetch(`${this.config.hubApiUrl}/api/agents`, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
      },
    })

    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`HTTP ${resp.status}: ${body}`)
    }

    const data = (await resp.json()) as { agents: Array<{ name: string; status: string }> }
    return data.agents
  }
}
