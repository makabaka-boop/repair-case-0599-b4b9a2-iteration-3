"""批次放行单：在**一次请求**里组合色差判定与 GS1 标签核验。

调色员放行新油墨桶时，合格的首张样张与刚扫描的桶标签必须对应到**同一张交接
凭据**，避免两项独立结果被误配。本模块复用既有的 :func:`app.judge.judge`
（CIEDE2000 舍入与 ≤ 2.00 判定）与 :func:`app.gs1.parse_gs1_label`（GS1 AI
解析、校验位、日历日期、逐字符身份），不复制任何规则。

组合裁决：

- 色差放行（未舍入 ΔE00 ≤ 2.00）**且**标签有效（成功解析出批次信息）
  → ``released=True`` 并生成一张放行单（含原始输入快照）；
- 色差超差、标签解析失败都是本次组合核验的**业务结果**（HTTP 仍为 200），
  二者在响应中分字段明确区分，且都**不生成半张凭据**（``release=None``）；
- 请求结构非法（Lab 越界/缺失、标签原文为空等）由端点层整次拒绝（422），
  与网络层异常一样不会进入本模块，前端按“请求异常/被拒绝”单独呈现。

放行单一旦生成即**固定于本次请求**：编号、签发时间、两组 Lab 与标签原文都取自
当次输入快照，后续编辑只能让页面把当前表单标记为与凭据不一致，不能改写凭据。
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any

from .ciede2000 import CIELab, ciede2000
from .gs1 import Gs1ParseError, parse_gs1_label
from .judge import judge


def utc_stamp() -> str:
    """当前 UTC 时间的秒级 ISO 时间戳（形如 2026-09-30T10:20:30Z）。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_release_number(now: datetime | None = None) -> str:
    """生成放行单编号：BR-YYYYMMDD- + 8 位随机十六进制（大写）。

    连续两次提交编号不同，避免迟到响应与较新放行单混淆。
    """
    now = now or datetime.now(timezone.utc)
    return f"BR-{now:%Y%m%d}-{secrets.token_hex(4).upper()}"


def _lab_snapshot(L: float, a: float, b: float) -> dict[str, float]:
    return {"L": L, "a": a, "b": b}


def evaluate_batch_release(
    standard: tuple[float, float, float],
    sample: tuple[float, float, float],
    raw_label: str,
) -> dict[str, Any]:
    """执行一次组合核验并组装响应。

    参数为已通过端点校验的 (L, a, b) 三元组与标签原文（逐字符原样）。
    返回结构固定为::

        {
          "ok": True,
          "snapshot": {"standard", "sample", "raw_label"},   # 原始输入快照
          "color":  {"passed", "result"},                    # 复用 judge
          "label":  {"valid", "format", "fields", "batch", "error"},
          "released": bool,                                  # 两项都过才 True
          "release": 放行单 | None,                          # 仅 released 时非空
        }
    """
    # 原始输入快照：数值取自本次请求的浮点数，标签原文逐字符保留
    # （尾随空格、FNC1 等都不做任何归一），作为放行单的字段身份依据。
    snapshot: dict[str, Any] = {
        "standard": _lab_snapshot(*standard),
        "sample": _lab_snapshot(*sample),
        "raw_label": raw_label,
    }

    # ── 核验一：色差（与 /api/delta-e 同一条判定路径） ──
    raw_delta = ciede2000(CIELab(*standard), CIELab(*sample))
    verdict = judge(raw_delta)
    color: dict[str, Any] = {"passed": bool(verdict["passed"]), "result": verdict}

    # ── 核验二：GS1 标签（与 /api/gs1-label 同一解析规则） ──
    # 解析失败是业务结果而非请求错误：保留错误代码与首个无法解析的位置，
    # 不产生任何批次信息。
    try:
        parsed = parse_gs1_label(raw_label)
    except Gs1ParseError as exc:
        label: dict[str, Any] = {
            "valid": False,
            "format": None,
            "fields": [],
            "batch": None,
            "error": {
                "code": exc.code,
                "message": exc.message,
                "position": exc.position,
            },
        }
    else:
        label = {
            "valid": True,
            "format": parsed["format"],
            "fields": parsed["fields"],
            "batch": parsed["batch"],
            "error": None,
        }

    released = bool(color["passed"]) and bool(label["valid"])

    release: dict[str, Any] | None = None
    if released:
        # 只有两项核验都通过才生成凭据；凭据内嵌本次输入快照，固定不可变。
        release = {
            "number": make_release_number(),
            "issued_at": utc_stamp(),
            **snapshot,
            "color": verdict,
            "batch": label["batch"],
        }

    return {
        "ok": True,
        "snapshot": snapshot,
        "color": color,
        "label": label,
        "released": released,
        "release": release,
    }
