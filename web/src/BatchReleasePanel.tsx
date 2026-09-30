import { useMemo, useRef, useState } from "react";
import { postBatchRelease } from "./api";
import { HighlightedRaw, VisibleValue } from "./label-visible";
import { COMPONENT_BOUNDS, EMPTY_FORM } from "./types";
import type {
  BatchReleaseSuccessResponse,
  ColorKey,
  ComponentKey,
  DeltaEResult,
  FieldError,
  LabForm,
  ReleaseNote,
} from "./types";
import { formToPayload, validateForm, type ClientErrors } from "./validation";

/**
 * 可选「批次放行单」流程：一次请求提交标准色、样张 Lab 值与桶标签原文，
 * 后端复用既有色差判定与 GS1 解析，两项核验在同一张凭据里对应起来。
 *
 * 不变量：
 *  1. 只有色差放行且标签有效（released=true）才显示放行单；解析失败/超差/请求
 *     异常三类明确区分，且都不显示凭据（不生成半张）。
 *  2. 放行单固定于当次请求：组件只保存那次响应快照，之后编辑输入只会被标记为
 *     「与当前表单不一致」，凭据展示与复制内容绝不随编辑改写。
 *  3. 连续提交按请求序号裁决：迟到响应（无论成功失败）一律丢弃，不覆盖更新的
 *     放行单或其页面状态。
 *  4. 本面板是独立入口：不读写上方色差比对与标签核验区，那两个入口的清理规则不变。
 */

type LabFieldId = `${ColorKey}.${ComponentKey}`;

interface RequestFailure {
  message: string;
  fieldErrors: FieldError[];
}

const COMP_ORDER: ComponentKey[] = ["L", "a", "b"];
const COLOR_TITLES: Record<ColorKey, string> = {
  standard: "标准色",
  sample: "首张样张",
};

function fmtNum(v: number): string {
  return String(v);
}

function fmt2(v: number): string {
  return v.toFixed(2);
}

/** 放行单的可复制纯文本：所有字段取自凭据自身（固定快照），不读当前表单。 */
function buildCopyText(note: ReleaseNote): string {
  return [
    "批次放行单",
    `编号：${note.number}`,
    `签发时间(UTC)：${note.issued_at}`,
    `标准色 L*a*b*：${fmtNum(note.standard.L)}, ${fmtNum(note.standard.a)}, ${fmtNum(note.standard.b)}`,
    `首张样张 L*a*b*：${fmtNum(note.sample.L)}, ${fmtNum(note.sample.a)}, ${fmtNum(note.sample.b)}`,
    `ΔE00：${fmt2(note.color.delta_e00_round)}（未舍入 ${note.color.delta_e00}）≤ 2.00，放行`,
    `商品编码(GTIN)：${note.batch.gtin}`,
    `批号：${note.batch.lot}`,
    `失效日期：${note.batch.expires}`,
    `标签原文：${note.raw_label}`,
  ].join("\n");
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 某些环境（非安全上下文/测试）没有 Clipboard API，回退到 execCommand
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function ColorVerdict({ result }: { result: DeltaEResult }) {
  return (
    <div
      className={`release-check ${result.passed ? "check-pass" : "check-fail"}`}
      data-testid="release-color-card"
      data-passed={result.passed ? "true" : "false"}
    >
      <strong data-testid="release-color-verdict">
        {result.passed ? "✅ 色差放行" : "⛔ 色差超差"}
      </strong>
      <span data-testid="release-color-delta">
        ΔE00 = {fmt2(result.delta_e00_round)}（未舍入 {result.delta_e00.toFixed(6)}）
        {result.passed ? " ≤ " : " > "}2.00
      </span>
      {!result.passed && (
        <span data-testid="release-color-excess">
          超出量 {fmt2(result.excess_round)}（未舍入 {result.excess_raw.toFixed(6)}）
        </span>
      )}
    </div>
  );
}

/** 当前表单数值与放行单快照逐字段比对；快照来自凭据，永不被编辑改写。 */
function useMismatches(note: ReleaseNote | null, form: LabForm, rawLabel: string) {
  return useMemo(() => {
    const fields: Partial<Record<LabFieldId, boolean>> = {};
    let any = false;
    if (note) {
      (Object.keys(form) as ColorKey[]).forEach((color) => {
        COMP_ORDER.forEach((comp) => {
          const text = form[color][comp].trim();
          const num = Number(text);
          const differs =
            text === "" ||
            !Number.isFinite(num) ||
            num !== note[color][comp];
          fields[`${color}.${comp}`] = differs;
          if (differs) any = true;
        });
      });
    }
    const labelDiffers = note !== null && rawLabel !== note.raw_label;
    if (labelDiffers) any = true;
    return { fields, labelDiffers, any };
  }, [note, form, rawLabel]);
}

export function BatchReleasePanel() {
  const [form, setForm] = useState<LabForm>(EMPTY_FORM);
  const [rawLabel, setRawLabel] = useState("");
  const [clientErrors, setClientErrors] = useState<ClientErrors>({});
  const [response, setResponse] = useState<BatchReleaseSuccessResponse | null>(null);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // 单调递增的请求序号：只接受最新一次请求的响应，迟到响应直接丢弃。
  const requestSeq = useRef(0);

  const hasLocalError = useMemo(
    () => Object.keys(validateForm(form)).length > 0 || rawLabel.trim() === "",
    [form, rawLabel],
  );

  // 只有真正生成凭据后才谈“与凭据不一致”；失败响应不产生凭据。
  const note = response?.released ? response.release : null;
  const mismatch = useMismatches(note, form, rawLabel);

  function handleLabChange(color: ColorKey, comp: ComponentKey, value: string) {
    setForm((prev) => ({ ...prev, [color]: { ...prev[color], [comp]: value } }));
    const next = { ...form, [color]: { ...form[color], [comp]: value } };
    setClientErrors(validateForm(next));
  }

  async function handleSubmit() {
    const errors = validateForm(form);
    setClientErrors(errors);
    if (Object.keys(errors).length > 0 || rawLabel.trim() === "") {
      // 本地非法：不发请求；旧凭据是固定凭据，不清除（重置才能清除），
      // 但也不会用非法输入生成任何新凭据。
      return;
    }

    const seq = ++requestSeq.current;
    setBusy(true);
    setFailure(null);
    const outcome = await postBatchRelease({
      ...formToPayload(form),
      raw_label: rawLabel,
    });
    // 迟到响应：已有更新的请求发出，本次结果（含成功放行单）一律不得落地。
    if (seq !== requestSeq.current) return;
    setBusy(false);

    if (outcome.ok) {
      setResponse(outcome.data);
      setFailure(null);
      setCopyState("idle");
    } else {
      // 请求异常 / 422 整次拒绝：清除上一张凭据与业务裁决，绝不残留半张凭据。
      setResponse(null);
      const err = outcome.error;
      setFailure({
        message:
          err?.message ??
          (outcome.status === 0
            ? "无法连接放行服务，请确认 API 已启动"
            : `放行请求失败（HTTP ${outcome.status}）`),
        fieldErrors: err?.errors ?? [],
      });
    }
  }

  function handleReset() {
    requestSeq.current += 1; // 让所有在途响应失效
    setForm(EMPTY_FORM);
    setRawLabel("");
    setClientErrors({});
    setResponse(null);
    setFailure(null);
    setBusy(false);
    setCopyState("idle");
  }

  async function handleCopy() {
    if (!note) return;
    const ok = await copyText(buildCopyText(note));
    setCopyState(ok ? "copied" : "failed");
  }

  return (
    <section className="release-panel" data-testid="release-panel">
      <h2>批次放行单（可选组合流程）</h2>
      <p className="hint-block">
        一次请求同时提交两组 Lab 值与桶标签原文：后端复用色差判定与 GS1 解析规则，
        在同一张交接凭据里给出两项核验与原始输入快照。<strong>只有色差放行且标签有效</strong>
        才生成放行单。本流程独立于上方两个入口，不改变其结果与清理规则。
      </p>

      <div className="cards">
        {(["standard", "sample"] as ColorKey[]).map((color) => (
          <fieldset className="color-card" key={color} data-testid={`release-fieldset-${color}`}>
            <legend>
              <strong>{COLOR_TITLES[color]}</strong>
            </legend>
            <div className="fields">
              {COMP_ORDER.map((comp) => {
                const bound = COMPONENT_BOUNDS[comp];
                const id: LabFieldId = `${color}.${comp}`;
                const msg = clientErrors[id];
                const differs = mismatch.fields[id];
                return (
                  <label key={comp} className="field" htmlFor={`release-${id}`}>
                    <span className="field-label">
                      {bound.greek}
                      <small>[{bound.min}, {bound.max}]</small>
                      {differs && (
                        <em
                          className="mismatch-tag"
                          data-testid={`release-mismatch-${id}`}
                        >
                          与放行单不一致
                        </em>
                      )}
                    </span>
                    <input
                      id={`release-${id}`}
                      data-testid={`release-${id}`}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-invalid={Boolean(msg)}
                      value={form[color][comp]}
                      onChange={(e) => handleLabChange(color, comp, e.target.value)}
                    />
                    {msg && (
                      <span className="field-error" role="alert">
                        {msg}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <label className="field label-input" htmlFor="release-label-raw">
        <span className="field-label">
          桶标签原文
          {mismatch.labelDiffers && (
            <em className="mismatch-tag" data-testid="release-mismatch-label">
              与放行单不一致
            </em>
          )}
        </span>
        <textarea
          id="release-label-raw"
          data-testid="release-label-raw"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          placeholder="例如 (01)09506000134352(10)INK2407(17)280930"
          value={rawLabel}
          onChange={(e) => setRawLabel(e.target.value)}
        />
      </label>

      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="release-submit"
          onClick={handleSubmit}
          disabled={hasLocalError}
        >
          提交组合核验
        </button>
        <button type="button" data-testid="release-reset" onClick={handleReset}>
          清空重置
        </button>
        {busy && (
          <span className="release-busy" data-testid="release-busy" aria-live="polite">
            核验中…
          </span>
        )}
      </div>

      {failure && (
        <div className="server-errors" data-testid="release-request-error" role="alert">
          <strong>{failure.message}</strong>
          {failure.fieldErrors.length > 0 && (
            <ul>
              {failure.fieldErrors.map((err, i) => (
                <li key={`${err.field}-${i}`}>
                  <code>{err.field}</code>：{err.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {response && (
        <div className="release-outcome" data-testid="release-outcome">
          <div className="release-checks">
            <ColorVerdict result={response.color.result} />
            {response.label.valid && response.label.batch ? (
              <div className="release-check check-pass" data-testid="release-label-card" data-valid="true">
                <strong data-testid="release-label-verdict">✅ 标签有效（{response.label.format === "readable" ? "带括号可读格式" : "扫码格式（FNC1 分隔）"}）</strong>
                <dl className="release-batch">
                  <div>
                    <dt>商品编码 (GTIN)</dt>
                    <VisibleValue text={response.label.batch.gtin} testId="release-gtin" />
                  </div>
                  <div>
                    <dt>批号</dt>
                    <VisibleValue text={response.label.batch.lot} testId="release-lot" />
                  </div>
                  <div>
                    <dt>失效日期</dt>
                    <VisibleValue text={response.label.batch.expires} testId="release-expires" />
                  </div>
                </dl>
              </div>
            ) : (
              <div className="release-check check-fail" data-testid="release-label-card" data-valid="false">
                <strong data-testid="release-label-verdict">⛔ 标签解析失败</strong>
                {response.label.error && (
                  <div data-testid="release-label-error">
                    <code>{response.label.error.code}</code>
                    {response.label.error.message}
                    {response.label.error.position !== null && (
                      <>
                        <div className="error-position" data-testid="release-label-error-position">
                          首个无法解析的位置：第 {response.label.error.position + 1} 个字符
                        </div>
                        <HighlightedRaw
                          raw={response.snapshot.raw_label}
                          position={response.label.error.position}
                          containerTestId="release-label-raw-highlight"
                          markTestId="release-label-error-char"
                        />
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {response.released && note ? (
            <div className="release-note" data-testid="release-note">
              <div className="release-note-head">
                <strong>✅ 批次放行单</strong>
                <span data-testid="release-number">编号：{note.number}</span>
                <span data-testid="release-issued-at">签发时间(UTC)：{note.issued_at}</span>
              </div>
              <dl className="release-note-body">
                <div>
                  <dt>标准色 L*a*b*</dt>
                  <dd data-testid="release-note-standard">
                    {fmtNum(note.standard.L)}, {fmtNum(note.standard.a)}, {fmtNum(note.standard.b)}
                  </dd>
                </div>
                <div>
                  <dt>首张样张 L*a*b*</dt>
                  <dd data-testid="release-note-sample">
                    {fmtNum(note.sample.L)}, {fmtNum(note.sample.a)}, {fmtNum(note.sample.b)}
                  </dd>
                </div>
                <div>
                  <dt>商品编码 (GTIN)</dt>
                  <dd data-testid="release-note-gtin">{note.batch.gtin}</dd>
                </div>
                <div>
                  <dt>批号</dt>
                  <VisibleValue text={note.batch.lot} testId="release-note-lot" />
                </div>
                <div>
                  <dt>失效日期</dt>
                  <dd data-testid="release-note-expires">{note.batch.expires}</dd>
                </div>
                <div>
                  <dt>标签原文快照</dt>
                  <dd>
                    <pre className="verbatim-value release-note-raw" data-testid="release-note-label">
                      {note.raw_label.replace(/ /g, "␠")}
                    </pre>
                  </dd>
                </div>
              </dl>
              <div className="actions">
                <button type="button" data-testid="release-copy" onClick={handleCopy}>
                  复制放行单
                </button>
                {copyState === "copied" && (
                  <span data-testid="release-copy-state">已复制到剪贴板</span>
                )}
                {copyState === "failed" && (
                  <span className="field-error" data-testid="release-copy-state">
                    复制失败，请手动选择文本
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="release-blocked" data-testid="release-not-released">
              <strong>⛔ 未生成放行单</strong>
              <ul>
                {!response.color.passed && (
                  <li data-testid="release-reason-color">色差超差（ΔE00 &gt; 2.00），不予放行</li>
                )}
                {!response.label.valid && (
                  <li data-testid="release-reason-label">标签解析失败，无有效批次信息</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}

      {note && mismatch.any && (
        <div className="mismatch-banner" data-testid="release-mismatch-banner" role="status">
          ⚠ 当前表单与这张放行单不一致：放行单固定于刚才那次请求，编辑输入不会改写凭据；
          如需新凭据请重新提交组合核验。
        </div>
      )}
    </section>
  );
}
