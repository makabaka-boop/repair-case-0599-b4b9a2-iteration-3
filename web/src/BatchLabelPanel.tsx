import { useState } from "react";
import { postGs1Label } from "./api";
import type { Gs1BatchInfo, Gs1LabelFormat } from "./types";

/**
 * 批次标签核验区：粘贴扫码枪读出的 GS1 标签原文，核验商品编码、批号、失效日期。
 *
 * 状态机：待输入(idle) → 已识别(recognized) / 已拒绝(rejected)。
 * 识别失败保留原文并高亮首个无法解析的位置；成功后可直接扫描下一桶。
 * 本区域状态完全独立，不读写标准色、样张与色差结论。
 */

type LabelStatus = "idle" | "recognized" | "rejected";

interface RejectInfo {
  message: string;
  position: number | null;
}

const STATUS_TEXT: Record<LabelStatus, string> = {
  idle: "待输入",
  recognized: "已识别",
  rejected: "已拒绝",
};

const FORMAT_TEXT: Record<Gs1LabelFormat, string> = {
  readable: "带括号可读格式",
  scan: "扫码格式（FNC1 分隔）",
};

/**
 * 把一个码点可视化为稳定可见的字形：控制字符用 Unicode 控制图形（每字符恰好
 * 一个码点，保持与原文 1:1 的下标映射），可打印字符原样返回。
 * 成功响应里字段值只可能含可打印 ASCII；这里同时服务于被拒绝原文的错误高亮，
 * 因此 NUL / TAB / LF / CR / GS / DEL 等都必须有唯一可见字形，杜绝不可见、
 * 折行或与普通字符混淆。
 */
function visibleCodePoint(ch: string): string {
  switch (ch) {
    case "\x00":
      return "␀";
    case "\t":
      return "␉";
    case "\n":
      return "␊";
    case "\r":
      return "␍";
    case "\x1d":
      return "␝";
    case "\x7f":
      return "␡";
    default: {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20) {
        // 其余 C0 控制字符统一显示为 U+2400 起始的控制图形
        return String.fromCodePoint(0x2400 + code);
      }
      return ch;
    }
  }
}

/** 按码点（而非 UTF-16 代码单元）拆分，emoji 等星平面字符也只占一个位置，
 *  保证后端给出的 position（Python 码点下标）与前端切片完全对齐。 */
function toCodePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * 识别成功后的字段值展示：后端逐字符保留合法值（含尾随空格）。
 * 空格（含尾随空格）显式显示为 ␠，配合 white-space: pre-wrap 避免 HTML
 * 折叠空格，让收料员能确认数据库值与标签逐字符一致。
 */
function VisibleValue({ text, testId }: { text: string; testId: string }) {
  const shown = text.replace(/ /g, "␠");
  return (
    <dd data-testid={testId} className="verbatim-value">
      {shown}
    </dd>
  );
}

/** 在原文中高亮首个无法解析的位置；位置越出末尾时给出末尾标记。 */
function HighlightedRaw({ raw, position }: { raw: string; position: number }) {
  const points = toCodePoints(raw);
  const shown = points.map(visibleCodePoint);
  if (position >= shown.length) {
    return (
      <pre className="raw-highlight" data-testid="label-raw-highlight">
        {shown.join("")}
        <mark data-testid="label-error-char">⇤末尾</mark>
      </pre>
    );
  }
  return (
    <pre className="raw-highlight" data-testid="label-raw-highlight">
      {shown.slice(0, position).join("")}
      <mark data-testid="label-error-char">{shown[position]}</mark>
      {shown.slice(position + 1).join("")}
    </pre>
  );
}

export function BatchLabelPanel() {
  const [raw, setRaw] = useState("");
  const [status, setStatus] = useState<LabelStatus>("idle");
  const [batch, setBatch] = useState<Gs1BatchInfo | null>(null);
  const [format, setFormat] = useState<Gs1LabelFormat | null>(null);
  const [reject, setReject] = useState<RejectInfo | null>(null);
  const [loading, setLoading] = useState(false);

  function clearOutcome() {
    setStatus("idle");
    setBatch(null);
    setFormat(null);
    setReject(null);
  }

  function handleChange(value: string) {
    // 原文一经修改，既有结论（已识别/已拒绝）即与框内文本失去对应，
    // 必须立即回到待输入并清除旧批次信息与错误定位，等待重新核验。
    setRaw(value);
    clearOutcome();
  }

  async function handleVerify() {
    setLoading(true);
    const outcome = await postGs1Label(raw);
    setLoading(false);
    if (outcome.ok) {
      setStatus("recognized");
      setBatch(outcome.data.batch);
      setFormat(outcome.data.format);
      setReject(null);
    } else {
      // 识别失败：原文不清空，展示错误与首个无法解析的位置
      setStatus("rejected");
      setBatch(null);
      setFormat(null);
      const err = outcome.error;
      setReject({
        message: err?.message ?? `请求失败（HTTP ${outcome.status}）`,
        position: err?.position ?? null,
      });
    }  }

  function handleNextBucket() {
    // 继续扫描下一桶：清空输入和当前核验结论。
    setRaw("");
    clearOutcome();
  }

  return (
    <section className="label-panel" data-testid="label-panel">
      <h2>批次标签核验（GS1）</h2>
      <p className="hint-block">
        收料时粘贴扫码枪读出的油墨桶标签原文，支持带括号可读格式
        <code>(01)…(10)…(17)…</code> 与含 FNC1 分隔符的扫描格式。
        本区域只核验标签，不影响上方色差比对。
      </p>

      <div className="label-status-row">
        <span
          className={`label-status status-${status}`}
          data-testid="label-status"
          data-status={status}
        >
          {STATUS_TEXT[status]}
        </span>
        {format && status === "recognized" && (
          <span className="label-format" data-testid="label-format">
            {FORMAT_TEXT[format]}
          </span>
        )}
      </div>

      <label className="field label-input" htmlFor="label-raw">
        <span className="field-label">标签原文</span>
        <textarea
          id="label-raw"
          data-testid="label-raw"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          placeholder="例如 (01)09506000134352(10)INK2407(17)280930"
          value={raw}
          disabled={loading}
          onChange={(e) => handleChange(e.target.value)}
        />
      </label>

      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="label-verify"
          onClick={handleVerify}
          disabled={loading || raw.trim() === ""}
        >
          {loading ? "核验中…" : "核验标签"}
        </button>
        {status === "recognized" && (
          <button
            type="button"
            data-testid="label-next"
            onClick={handleNextBucket}
            disabled={loading}
          >
            扫描下一桶
          </button>
        )}
      </div>

      {status === "rejected" && reject && (
        <div className="server-errors" data-testid="label-error" role="alert">
          <strong>{reject.message}</strong>
          {/* position 可能为 0（首字符即无法解析），必须显式判空，不能用真值判断 */}
          {reject.position !== null && reject.position !== undefined && (
            <div className="error-position" data-testid="label-error-position">
              首个无法解析的位置：第 {reject.position + 1} 个字符
            </div>
          )}
          {reject.position !== null && reject.position !== undefined && (
            <HighlightedRaw raw={raw} position={reject.position} />
          )}
        </div>
      )}

      {status === "recognized" && batch && (
        <div className="label-result" data-testid="label-result" aria-live="polite">
          <dl>
            <div>
              <dt>商品编码 (GTIN)</dt>
              <VisibleValue text={batch.gtin} testId="label-gtin" />
            </div>
            <div>
              <dt>批号</dt>
              <VisibleValue text={batch.lot} testId="label-lot" />
            </div>
            <div>
              <dt>失效日期</dt>
              <VisibleValue text={batch.expires} testId="label-expires" />
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
