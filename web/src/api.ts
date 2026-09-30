import type {
  BatchReleaseErrorResponse,
  BatchReleaseSuccessResponse,
  DeltaEErrorResponse,
  DeltaESuccessResponse,
  Gs1LabelErrorResponse,
  Gs1LabelSuccessResponse,
} from "./types";

export type ApiOutcome =
  | { ok: true; data: DeltaESuccessResponse }
  | { ok: false; status: number; error: DeltaEErrorResponse | null };

/** 调用 /api/delta-e；网络层错误同样按“整次拒绝”处理。 */
export async function postDeltaE(payload: unknown): Promise<ApiOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/delta-e", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        ok: false,
        message: "无法连接计算服务，请确认 API 已启动",
        errors: [{ field: "network", message: "网络请求失败" }],
      },
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok && body && typeof body === "object" && (body as DeltaESuccessResponse).ok === true) {
    return { ok: true, data: body as DeltaESuccessResponse };
  }
  return {
    ok: false,
    status: res.status,
    error: body as DeltaEErrorResponse | null,
  };
}

export type Gs1LabelOutcome =
  | { ok: true; data: Gs1LabelSuccessResponse }
  | { ok: false; status: number; error: Gs1LabelErrorResponse | null };

/** 调用 /api/gs1-label；网络层错误同样按“识别失败”处理，不影响色差比对。 */
export async function postGs1Label(raw: string): Promise<Gs1LabelOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/gs1-label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        ok: false,
        message: "无法连接标签解析服务，请确认 API 已启动（色差比对不受影响）",
        errors: [{ field: "network", message: "网络请求失败" }],
        position: null,
      },
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok && body && typeof body === "object" && (body as Gs1LabelSuccessResponse).ok === true) {
    return { ok: true, data: body as Gs1LabelSuccessResponse };
  }
  return {
    ok: false,
    status: res.status,
    error: body as Gs1LabelErrorResponse | null,
  };
}

export type BatchReleaseOutcome =
  | { ok: true; data: BatchReleaseSuccessResponse }
  | {
      /** false 覆盖 422 结构拒绝与网络层异常（status=0），与业务裁决 released=false 区分。 */
      ok: false;
      status: number;
      error: BatchReleaseErrorResponse | null;
    };

/** 调用 /api/batch-release：一次请求完成色差判定 + 标签解析；网络层错误按“请求异常”处理。 */
export async function postBatchRelease(payload: unknown): Promise<BatchReleaseOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/batch-release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        ok: false,
        message: "无法连接放行服务，请确认 API 已启动",
        errors: [{ field: "network", message: "网络请求失败" }],
      },
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (
    res.ok &&
    body &&
    typeof body === "object" &&
    (body as BatchReleaseSuccessResponse).ok === true
  ) {
    return { ok: true, data: body as BatchReleaseSuccessResponse };
  }
  return {
    ok: false,
    status: res.status,
    error: body as BatchReleaseErrorResponse | null,
  };
}
