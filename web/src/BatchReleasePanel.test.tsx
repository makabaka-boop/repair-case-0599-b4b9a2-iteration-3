import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchReleasePanel } from "./BatchReleasePanel";

/** 放行色对（≈1.2644）与超差色对（≈2.0425） */
const PASS_STD = { L: 60.2574, a: -34.0099, b: 36.2677 };
const PASS_SMP = { L: 60.4626, a: -34.1751, b: 39.4387 };
const FAIL_STD = { L: 50.0, a: 2.6772, b: -79.7751 };
const FAIL_SMP = { L: 50.0, a: 0.0, b: -82.7485 };

const LABEL_OK = "(01)09506000134352(10)INK2407(17)280930";
const LABEL_BAD_CHECK = "(01)09506000134353(10)INK2407(17)280930";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    snapshot: { standard: PASS_STD, sample: PASS_SMP, raw_label: LABEL_OK },
    color: {
      passed: true,
      result: {
        delta_e00: 1.2643671,
        delta_e00_round: 1.26,
        threshold: 2.0,
        passed: true,
        excess_raw: 0.0,
        excess_round: 0.0,
        relation: "<=",
      },
    },
    label: {
      valid: true,
      format: "readable",
      fields: [],
      batch: { gtin: "09506000134352", lot: "INK2407", expires: "2028-09-30" },
      error: null,
    },
    released: true,
    release: null,
    ...overrides,
  };
}

function releasedNote(overrides: Record<string, unknown> = {}) {
  const body = successBody();
  return {
    ...body,
    release: {
      number: "BR-20260930-DEADBEEF",
      issued_at: "2026-09-30T10:20:30Z",
      ...body.snapshot,
      color: body.color.result,
      batch: body.label.batch,
    },
    ...overrides,
  };
}

function mockResponse(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  (globalThis.fetch as FetchMock).mockImplementation(impl);
}

async function fillLab(
  user: ReturnType<typeof userEvent.setup>,
  std: { L: number; a: number; b: number },
  smp: { L: number; a: number; b: number },
) {
  const vals: Array<[string, string]> = [
    ["standard.L", String(std.L)],
    ["standard.a", String(std.a)],
    ["standard.b", String(std.b)],
    ["sample.L", String(smp.L)],
    ["sample.a", String(smp.a)],
    ["sample.b", String(smp.b)],
  ];
  for (const [id, v] of vals) {
    await user.clear(screen.getByTestId(`release-${id}`));
    await user.type(screen.getByTestId(`release-${id}`), v);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("批次放行单：组合裁决页面", () => {
  it("两项都过：显示两张核验卡与放行单（编号/快照/批次），无失败提示", async () => {
    const user = userEvent.setup();
    mockResponse(async () => jsonResponse(200, releasedNote()));

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));

    expect(await screen.findByTestId("release-note")).toBeInTheDocument();
    expect(screen.getByTestId("release-color-card")).toHaveAttribute(
      "data-passed",
      "true",
    );
    expect(screen.getByTestId("release-label-card")).toHaveAttribute(
      "data-valid",
      "true",
    );
    expect(screen.getByTestId("release-number")).toHaveTextContent(
      "BR-20260930-DEADBEEF",
    );
    expect(screen.getByTestId("release-issued-at")).toHaveTextContent(
      "2026-09-30T10:20:30Z",
    );
    expect(screen.getByTestId("release-note-standard")).toHaveTextContent(
      "60.2574, -34.0099, 36.2677",
    );
    expect(screen.getByTestId("release-note-gtin")).toHaveTextContent(
      "09506000134352",
    );
    expect(screen.getByTestId("release-note-label")).toHaveTextContent(LABEL_OK);
    expect(screen.queryByTestId("release-not-released")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-request-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-mismatch-banner")).not.toBeInTheDocument();
  });

  it("色差放行 + 标签解析失败：色差卡保留、标签失败可定位，不生成凭据", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(
        200,
        successBody({
          snapshot: { standard: PASS_STD, sample: PASS_SMP, raw_label: LABEL_BAD_CHECK },
          label: {
            valid: false,
            format: null,
            fields: [],
            batch: null,
            error: {
              code: "invalid_checksum",
              message: "商品编码校验位错误：应为 2，实际为 3",
              position: 17,
            },
          },
          released: false,
          release: null,
        }),
      ),
    );

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_BAD_CHECK);
    await user.click(screen.getByTestId("release-submit"));

    const blocked = await screen.findByTestId("release-not-released");
    expect(blocked).toHaveTextContent("标签解析失败");
    expect(screen.getByTestId("release-reason-label")).toBeInTheDocument();
    expect(screen.queryByTestId("release-reason-color")).not.toBeInTheDocument();
    expect(screen.getByTestId("release-color-card")).toHaveAttribute(
      "data-passed",
      "true",
    );
    expect(screen.getByTestId("release-label-card")).toHaveAttribute(
      "data-valid",
      "false",
    );
    expect(screen.getByTestId("release-label-error-position")).toHaveTextContent(
      "第 18 个字符",
    );
    expect(screen.getByTestId("release-label-error-char")).toHaveTextContent("3");
    expect(screen.queryByTestId("release-note")).not.toBeInTheDocument();
  });

  it("色差超差 + 标签有效：显示 ΔE00=2.04 与超出量，不生成凭据", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(
        200,
        successBody({
          snapshot: { standard: FAIL_STD, sample: FAIL_SMP, raw_label: LABEL_OK },
          color: {
            passed: false,
            result: {
              delta_e00: 2.0424586,
              delta_e00_round: 2.04,
              threshold: 2.0,
              passed: false,
              excess_raw: 0.0424586,
              excess_round: 0.04,
              relation: ">",
            },
          },
          released: false,
          release: null,
        }),
      ),
    );

    render(<BatchReleasePanel />);
    await fillLab(user, FAIL_STD, FAIL_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));

    const blocked = await screen.findByTestId("release-not-released");
    expect(blocked).toHaveTextContent("色差超差");
    expect(screen.getByTestId("release-reason-color")).toBeInTheDocument();
    expect(screen.queryByTestId("release-reason-label")).not.toBeInTheDocument();
    expect(screen.getByTestId("release-color-card")).toHaveAttribute(
      "data-passed",
      "false",
    );
    expect(screen.getByTestId("release-color-verdict")).toHaveTextContent("色差超差");
    expect(screen.getByTestId("release-color-delta")).toHaveTextContent("2.04");
    expect(screen.getByTestId("release-color-excess")).toHaveTextContent("0.04");
    expect(screen.getByTestId("release-label-card")).toHaveAttribute(
      "data-valid",
      "true",
    );
    expect(screen.queryByTestId("release-note")).not.toBeInTheDocument();
  });

  it("请求异常（网络失败）：明确提示且页面无任何凭据/业务裁决", async () => {
    const user = userEvent.setup();
    (globalThis.fetch as FetchMock).mockRejectedValue(new TypeError("fetch failed"));

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));

    const err = await screen.findByTestId("release-request-error");
    expect(err).toHaveTextContent("无法连接放行服务");
    expect(screen.queryByTestId("release-note")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-outcome")).not.toBeInTheDocument();
  });

  it("422 结构拒绝：显示字段明细，不残留旧放行单（不生成半张凭据）", async () => {
    const user = userEvent.setup();
    let call = 0;
    mockResponse(async () => {
      call += 1;
      if (call === 1) return jsonResponse(200, releasedNote());
      return jsonResponse(422, {
        ok: false,
        message: "输入校验失败，整次请求被拒绝（未进行计算，也不会更新旧结果）",
        errors: [
          { field: "sample.b", message: "超出允许范围 [-128, 127]，端点包含" },
        ],
      });
    });

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    expect(await screen.findByTestId("release-note")).toBeInTheDocument();

    await user.click(screen.getByTestId("release-submit"));
    await waitFor(() => expect(call).toBe(2));
    expect(await screen.findByTestId("release-request-error")).toHaveTextContent(
      "sample.b",
    );
    expect(screen.queryByTestId("release-note")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-outcome")).not.toBeInTheDocument();
  });

  it("本地非法输入：提交按钮禁用，不发请求", async () => {
    const user = userEvent.setup();
    render(<BatchReleasePanel />);
    expect(screen.getByTestId("release-submit")).toBeDisabled();
    await user.type(screen.getByTestId("release-standard.L"), "50");
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    // 仍缺其余 Lab 字段
    expect(screen.getByTestId("release-submit")).toBeDisabled();
    expect((globalThis.fetch as FetchMock)).not.toHaveBeenCalled();
  });
});

describe("批次放行单：凭据固定与输入修改", () => {
  it("生成放行单后编辑 Lab：凭据原文不变，仅标记不一致；改回后标记消失", async () => {
    const user = userEvent.setup();
    mockResponse(async () => jsonResponse(200, releasedNote()));

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    expect(await screen.findByTestId("release-note")).toBeInTheDocument();

    // 编辑标准色 L*
    await user.clear(screen.getByTestId("release-standard.L"));
    await user.type(screen.getByTestId("release-standard.L"), "61");

    // 凭据仍固定显示旧值，且整体不一致横幅出现
    expect(screen.getByTestId("release-note")).toBeInTheDocument();
    expect(screen.getByTestId("release-note-standard")).toHaveTextContent(
      "60.2574, -34.0099, 36.2677",
    );
    expect(screen.getByTestId("release-mismatch-standard.L")).toBeInTheDocument();
    expect(screen.getByTestId("release-mismatch-banner")).toBeInTheDocument();
    // 复制内容同样来自固定凭据（在 handleCopy 时生成），此处先确认凭据块未随表单变
    expect(screen.getByTestId("release-standard.L")).toHaveValue("61");
    // 其他未改字段不标不一致
    expect(screen.queryByTestId("release-mismatch-sample.L")).not.toBeInTheDocument();

    // 改回弹照值 → 标记消失
    await user.clear(screen.getByTestId("release-standard.L"));
    await user.type(screen.getByTestId("release-standard.L"), String(PASS_STD.L));
    expect(
      screen.queryByTestId("release-mismatch-banner"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("release-mismatch-standard.L"),
    ).not.toBeInTheDocument();
  });

  it("生成放行单后编辑标签原文：批号凭据不变，仅标签项标记不一致", async () => {
    const user = userEvent.setup();
    mockResponse(async () => jsonResponse(200, releasedNote()));

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    await screen.findByTestId("release-note");

    await user.type(screen.getByTestId("release-label-raw"), "X");
    expect(screen.getByTestId("release-mismatch-label")).toBeInTheDocument();
    expect(screen.getByTestId("release-mismatch-banner")).toBeInTheDocument();
    // 凭据中的标签快照与批号不变
    expect(screen.getByTestId("release-note-label")).toHaveTextContent(LABEL_OK);
    expect(screen.getByTestId("release-note-lot")).toHaveTextContent("INK2407");
  });

  it("复制放行单：剪贴板内容为固定凭据全文（含编号、快照、批次），不含当前表单改动", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText: vi.fn() },
      configurable: true,
    });
    mockResponse(async () => jsonResponse(200, releasedNote()));

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    await screen.findByTestId("release-note");

    // 编辑当前表单（与凭据无关的独特值，不出现在固定凭据任何字段中）
    await user.clear(screen.getByTestId("release-standard.L"));
    await user.type(screen.getByTestId("release-standard.L"), "88");

    await user.click(screen.getByTestId("release-copy"));
    await screen.findByTestId("release-copy-state");
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("批次放行单");
    expect(copied).toContain("BR-20260930-DEADBEEF");
    expect(copied).toContain("标准色 L*a*b*：60.2574, -34.0099, 36.2677"); // 固定快照
    expect(copied).toContain("商品编码(GTIN)：09506000134352");
    expect(copied).toContain("批号：INK2407");
    expect(copied).toContain(`标签原文：${LABEL_OK}`);
    expect(copied).not.toContain("88"); // 当前表单改动绝不渗入凭据
  });

  it("连续提交乱序：先慢后快，较早（迟到）响应不得覆盖较新放行单", async () => {
    const user = userEvent.setup();
    const first = deferred<Response>();
    const second = deferred<Response>();
    let call = 0;
    mockResponse(async () => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);

    // 第一次提交（慢）
    await user.click(screen.getByTestId("release-submit"));
    await waitFor(() => expect(call).toBe(1));

    // 第二次提交（更快返回一张不同编号的放行单）
    await user.click(screen.getByTestId("release-submit"));
    await waitFor(() => expect(call).toBe(2));

    second.resolve(
      jsonResponse(200, releasedNote({ release: {
        ...releasedNote().release,
        number: "BR-20260930-NEWNEW11",
      } })),
    );
    await waitFor(() =>
      expect(screen.getByTestId("release-number")).toHaveTextContent(
        "BR-20260930-NEWNEW11",
      ),
    );

    // 第一次迟到响应落地（较旧）：必须被序号守卫丢弃
    first.resolve(jsonResponse(200, releasedNote()));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("release-number")).toHaveTextContent(
      "BR-20260930-NEWNEW11",
    );
    expect(screen.getByTestId("release-note")).not.toHaveTextContent(
      "BR-20260930-DEADBEEF",
    );
  });

  it("连续提交乱序：较早的失败响应不得覆盖较新的成功放行单", async () => {
    const user = userEvent.setup();
    const first = deferred<Response>();
    const second = deferred<Response>();
    let call = 0;
    mockResponse(async () => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);

    await user.click(screen.getByTestId("release-submit"));
    await waitFor(() => expect(call).toBe(1));
    await user.click(screen.getByTestId("release-submit"));
    await waitFor(() => expect(call).toBe(2));

    // 第二次（新）成功
    second.resolve(jsonResponse(200, releasedNote()));
    expect(await screen.findByTestId("release-note")).toBeInTheDocument();

    // 第一次（旧）迟到且是网络式 422 拒绝：不得清掉新放行单
    first.resolve(
      jsonResponse(422, {
        ok: false,
        message: "输入校验失败，整次请求被拒绝",
        errors: [],
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("release-note")).toBeInTheDocument();
    expect(screen.queryByTestId("release-request-error")).not.toBeInTheDocument();
  });

  it("清空重置：表单、放行单、不一致标记与在途响应全部失效", async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    mockResponse(async () => pending.promise);

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    // 在途时重置
    await user.click(screen.getByTestId("release-reset"));
    expect(screen.getByTestId("release-label-raw")).toHaveValue("");
    expect(screen.queryByTestId("release-note")).not.toBeInTheDocument();

    // 迟到响应不得渲染
    pending.resolve(jsonResponse(200, releasedNote()));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("release-note")).not.toBeInTheDocument();
  });

  it("批号尾随空格：放行单批号逐字符显示 ␠ 且与无空格批号身份不同", async () => {
    const user = userEvent.setup();
    const rawWithSpace = "(01)09506000134352(10)INK2407 (17)280930";
    mockResponse(async () =>
      jsonResponse(
        200,
        releasedNote({
          snapshot: { standard: PASS_STD, sample: PASS_SMP, raw_label: rawWithSpace },
          label: {
            valid: true,
            format: "readable",
            fields: [],
            batch: { gtin: "09506000134352", lot: "INK2407 ", expires: "2028-09-30" },
            error: null,
          },
          release: {
            ...releasedNote().release,
            raw_label: rawWithSpace,
            batch: { gtin: "09506000134352", lot: "INK2407 ", expires: "2028-09-30" },
          },
        }),
      ),
    );

    render(<BatchReleasePanel />);
    await fillLab(user, PASS_STD, PASS_SMP);
    await user.type(screen.getByTestId("release-label-raw"), rawWithSpace);
    await user.click(screen.getByTestId("release-submit"));

    await screen.findByTestId("release-note");
    expect(screen.getByTestId("release-note-lot")).toHaveTextContent("INK2407␠");
    expect(screen.getByTestId("release-note-lot").textContent).toBe("INK2407␠");
    expect(screen.getByTestId("release-note-lot").textContent).not.toBe("INK2407");
  });
});
