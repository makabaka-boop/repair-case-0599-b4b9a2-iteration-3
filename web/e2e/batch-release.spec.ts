import { expect, test, type Route } from "@playwright/test";

/**
 * 批次放行单端到端：浏览器 → FastAPI（dev 下由 Vite 反代 /api），真实服务。
 * 覆盖：组合裁决（放行/超差/解析失败/422/网络异常）、失败后页面状态、
 * 凭据固定于当次请求 + 输入修改只标记不一致、连续提交乱序响应不覆盖新放行单、
 * 复制放行单，以及与两个既有独立入口互不干扰。
 */

const PASS = {
  standard: [60.2574, -34.0099, 36.2677],
  sample: [60.4626, -34.1751, 39.4387],
};
const FAIL = {
  standard: [50.0, 2.6772, -79.7751],
  sample: [50.0, 0.0, -82.7485],
};
const LABEL_OK = "(01)09506000134352(10)INK2407(17)280930";
const LABEL_BAD_CHECK = "(01)09506000134353(10)INK2407(17)280930";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

async function fillReleaseLab(
  page: import("@playwright/test").Page,
  pair: { standard: number[]; sample: number[] },
) {
  const [l1, a1, b1] = pair.standard;
  const [l2, a2, b2] = pair.sample;
  await page.getByTestId("release-standard.L").fill(String(l1));
  await page.getByTestId("release-standard.a").fill(String(a1));
  await page.getByTestId("release-standard.b").fill(String(b1));
  await page.getByTestId("release-sample.L").fill(String(l2));
  await page.getByTestId("release-sample.a").fill(String(a2));
  await page.getByTestId("release-sample.b").fill(String(b2));
}

test("色差放行 + 标签有效：生成固定于本次输入的放行单（编号/快照/批次）", async ({
  page,
}) => {
  await fillReleaseLab(page, PASS);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await page.getByTestId("release-submit").click();

  await expect(page.getByTestId("release-note")).toBeVisible();
  await expect(page.getByTestId("release-color-card")).toHaveAttribute(
    "data-passed",
    "true",
  );
  await expect(page.getByTestId("release-label-card")).toHaveAttribute(
    "data-valid",
    "true",
  );
  await expect(page.getByTestId("release-number")).toContainText(/BR-\d{8}-[0-9A-F]{8}/);
  await expect(page.getByTestId("release-note-standard")).toHaveText(
    "60.2574, -34.0099, 36.2677",
  );
  await expect(page.getByTestId("release-note-sample")).toHaveText(
    "60.4626, -34.1751, 39.4387",
  );
  await expect(page.getByTestId("release-note-gtin")).toHaveText("09506000134352");
  await expect(page.getByTestId("release-note-lot")).toHaveText("INK2407");
  await expect(page.getByTestId("release-note-expires")).toHaveText("2028-09-30");
  await expect(page.getByTestId("release-note-label")).toHaveText(LABEL_OK);
  await expect(page.getByTestId("release-not-released")).toHaveCount(0);
  await expect(page.getByTestId("release-request-error")).toHaveCount(0);
});

test("色差超差 + 标签有效：不生成凭据，给出色差原因与超出量，标签批次仍展示", async ({
  page,
}) => {
  await fillReleaseLab(page, FAIL);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await page.getByTestId("release-submit").click();

  await expect(page.getByTestId("release-not-released")).toBeVisible();
  await expect(page.getByTestId("release-reason-color")).toBeVisible();
  await expect(page.getByTestId("release-reason-label")).toHaveCount(0);
  await expect(page.getByTestId("release-color-card")).toHaveAttribute(
    "data-passed",
    "false",
  );
  await expect(page.getByTestId("release-color-delta")).toContainText("2.04");
  await expect(page.getByTestId("release-color-excess")).toContainText("0.04");
  await expect(page.getByTestId("release-gtin")).toHaveText("09506000134352");
  await expect(page.getByTestId("release-note")).toHaveCount(0);
});

test("色差放行 + 标签解析失败：不生成凭据、定位损坏校验位，修正后重新生成", async ({
  page,
}) => {
  await fillReleaseLab(page, PASS);
  await page.getByTestId("release-label-raw").fill(LABEL_BAD_CHECK);
  await page.getByTestId("release-submit").click();

  await expect(page.getByTestId("release-label-card")).toHaveAttribute(
    "data-valid",
    "false",
  );
  await expect(page.getByTestId("release-label-error")).toContainText(
    "invalid_checksum",
  );
  await expect(page.getByTestId("release-label-error-position")).toContainText(
    "第 18 个字符",
  );
  await expect(page.getByTestId("release-label-error-char")).toHaveText("3");
  await expect(page.getByTestId("release-reason-label")).toBeVisible();
  await expect(page.getByTestId("release-note")).toHaveCount(0);
  // 这是业务失败而非请求异常
  await expect(page.getByTestId("release-request-error")).toHaveCount(0);

  // 修正标签后重新提交 → 放行单生成（失败页面状态可恢复）
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await page.getByTestId("release-submit").click();
  await expect(page.getByTestId("release-note")).toBeVisible();
  await expect(page.getByTestId("release-not-released")).toHaveCount(0);
});

test("两项都失败：同时列出超差与标签失败两个原因，无半张凭据", async ({ page }) => {
  await fillReleaseLab(page, FAIL);
  await page.getByTestId("release-label-raw").fill(LABEL_BAD_CHECK);
  await page.getByTestId("release-submit").click();

  await expect(page.getByTestId("release-reason-color")).toBeVisible();
  await expect(page.getByTestId("release-reason-label")).toBeVisible();
  await expect(page.getByTestId("release-note")).toHaveCount(0);
});

test("直接 API：Lab 越界整次 422 拒绝（与业务失败区分，无 released/release 字段）", async ({
  page,
}) => {
  const resp = await page.request.post("/api/batch-release", {
    data: {
      standard: { L: 50, a: 0, b: 0 },
      sample: { L: 50, a: 0, b: 9999 },
      raw_label: LABEL_OK,
    },
  });
  expect(resp.status()).toBe(422);
  const body = await resp.json();
  expect(body.ok).toBe(false);
  expect(body.errors.some((e: { field: string }) => e.field === "sample.b")).toBe(true);
  expect(body).not.toHaveProperty("release");
  expect(body).not.toHaveProperty("released");
});

test("凭据固定：放行后修改输入只标记不一致、不改写凭据；重新提交才产生新凭据", async ({
  page,
}) => {
  await fillReleaseLab(page, PASS);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await page.getByTestId("release-submit").click();
  await expect(page.getByTestId("release-note")).toBeVisible();
  const number1 = (await page.getByTestId("release-number").textContent()) ?? "";
  expect(number1).toMatch(/BR-\d{8}-[0-9A-F]{8}/);

  // 修改样张 L*：凭据不动，只出现不一致标记
  await page.getByTestId("release-sample.L").fill("70");
  await expect(page.getByTestId("release-mismatch-sample.L")).toBeVisible();
  await expect(page.getByTestId("release-mismatch-banner")).toBeVisible();
  await expect(page.getByTestId("release-note-sample")).toHaveText(
    "60.4626, -34.1751, 39.4387",
  );

  // 再改标签原文：标签项也标记不一致，凭据批号不变
  await page.getByTestId("release-label-raw").fill(`${LABEL_OK}X`);
  await expect(page.getByTestId("release-mismatch-label")).toBeVisible();
  await expect(page.getByTestId("release-note-lot")).toHaveText("INK2407");

  // 恢复到与凭据一致 → 标记消失，凭据仍是原来那张
  await page.getByTestId("release-sample.L").fill(String(PASS.sample[0]));
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await expect(page.getByTestId("release-mismatch-banner")).toHaveCount(0);
  await expect(page.getByTestId("release-number")).toHaveText(number1);

  // 再次提交 → 产生新编号的新凭据
  await page.getByTestId("release-submit").click();
  await expect
    .poll(async () => (await page.getByTestId("release-number").textContent()) ?? "")
    .not.toBe(number1);
});

test("复制放行单：剪贴板内容为凭据快照全文，编辑表单后复制内容也不被改写", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fillReleaseLab(page, PASS);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await page.getByTestId("release-submit").click();
  await expect(page.getByTestId("release-note")).toBeVisible();

  await page.getByTestId("release-sample.L").fill("70"); // 与凭据不一致
  await page.getByTestId("release-copy").click();
  await expect(page.getByTestId("release-copy-state")).toContainText("已复制");

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("批次放行单");
  expect(clipboard).toMatch(/BR-\d{8}-[0-9A-F]{8}/);
  expect(clipboard).toContain("标准色 L*a*b*：60.2574, -34.0099, 36.2677");
  expect(clipboard).toContain("首张样张 L*a*b*：60.4626, -34.1751, 39.4387"); // 固定快照
  expect(clipboard).toContain("商品编码(GTIN)：09506000134352");
  expect(clipboard).toContain(`标签原文：${LABEL_OK}`);
  expect(clipboard).not.toContain("70");
});

test("请求异常（网络中断）：明确提示且不生成凭据；恢复后可重新提交成功", async ({
  page,
}) => {
  await fillReleaseLab(page, PASS);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);

  // 首次请求在网络层失败
  await page.route("**/api/batch-release", (route) => route.abort("failed"));
  await page.getByTestId("release-submit").click();
  await expect(page.getByTestId("release-request-error")).toContainText(
    "无法连接放行服务",
  );
  await expect(page.getByTestId("release-note")).toHaveCount(0);
  await expect(page.getByTestId("release-outcome")).toHaveCount(0);

  // 网络恢复（取消拦截）后重新提交 → 成功
  await page.unroute("**/api/batch-release");
  await page.getByTestId("release-submit").click();
  await expect(page.getByTestId("release-note")).toBeVisible();
  await expect(page.getByTestId("release-request-error")).toHaveCount(0);
});

test("乱序响应：较早提交的迟到响应不得覆盖较新放行单", async ({ page }) => {
  await fillReleaseLab(page, PASS);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);

  // 第 1 次请求挂起；第 2 次请求立即放行到真实 API
  let firstRoute: Route | null = null;
  await page.route("**/api/batch-release", async (route) => {
    if (firstRoute === null) {
      firstRoute = route;
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response });
  });

  await page.getByTestId("release-submit").click();
  await expect(page.getByTestId("release-busy")).toBeVisible();
  // 第二次提交（在第一次仍在途时）
  await page.getByTestId("release-submit").click();

  // 第二次先返回 → 新放行单落地
  await expect(page.getByTestId("release-note")).toBeVisible();
  const number2 = (await page.getByTestId("release-number").textContent()) ?? "";
  expect(number2).toMatch(/BR-\d{8}-[0-9A-F]{8}/);

  // 第一次迟到响应这时才返回真实结果（不同编号）：必须被丢弃
  const delayed = await firstRoute!.fetch();
  await firstRoute!.fulfill({ response: delayed });
  await page.waitForTimeout(300);
  await expect(page.getByTestId("release-number")).toHaveText(number2);
});

test("组合流程不影响既有独立入口：上方色差与标签核验仍各自独立工作", async ({
  page,
}) => {
  // 既有独立色差入口
  await page.getByTestId("standard.L").fill(String(PASS.standard[0]));
  await page.getByTestId("standard.a").fill(String(PASS.standard[1]));
  await page.getByTestId("standard.b").fill(String(PASS.standard[2]));
  await page.getByTestId("sample.L").fill(String(PASS.sample[0]));
  await page.getByTestId("sample.a").fill(String(PASS.sample[1]));
  await page.getByTestId("sample.b").fill(String(PASS.sample[2]));
  await page.getByTestId("compare-button").click();
  await expect(page.getByTestId("result-panel")).toHaveAttribute(
    "data-passed",
    "true",
  );

  // 既有独立标签入口
  await page.getByTestId("label-raw").fill(LABEL_OK);
  await page.getByTestId("label-verify").click();
  await expect(page.getByTestId("label-status")).toHaveText("已识别");
  await expect(page.getByTestId("label-gtin")).toHaveText("09506000134352");

  // 组合流程初始仍为空（两个独立入口的数据不渗入）
  await expect(page.getByTestId("release-standard.L")).toHaveValue("");
  await expect(page.getByTestId("release-label-raw")).toHaveValue("");
  await expect(page.getByTestId("release-note")).toHaveCount(0);
});
