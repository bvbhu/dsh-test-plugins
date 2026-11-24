/**
 * 子代理会话的「模型选择器」——复刻 DSH 原生 `ModelSelect` 的视觉与交互。
 *
 * 为什么自建:原生 client 选择器对**任何**子代理会话硬禁用
 * (`ui-model-selection/src/client/directory.ts:152` 抛
 * `model selection is unavailable for addressed subagent sessions`,
 * `ModelSelect.tsx:217 if (!available) return null`)。而 continuation 子代理
 * 会话有正常的输入框(与父会话一致),用户定案要在这里放一个**一模一样**的
 * 控件 —— 位置(`conversation.input.right`,提交按钮前的紧凑控件)、两级菜单(模型/思考强度)、
 * provider 分组、>4 项搜索、勾选态、Toast 报错全部照抄原生。
 *
 * 为什么只在 continu able 渲染:one-shot / unknown 子代理没有输入框
 * (`ui-subagent` 把它们换成只读 composer),控件无处安放;用标准属性
 * `useProjection('subagent')` 判断 mode,同步、无异步闪烁。
 *
 * 数据流:目录/切换都走 as-one 自家 HTTP API(`client/api.ts`)。目录由 host
 * 中转宿主 `sessionController.modelCatalog()`;切换不能走宿主的 `selectModel`
 * (它对子代理会话硬拒绝):运行时写入 `agent/created` 缓存的 child Session;
 * 休眠时把目标选择持久化到 as-one SQLite(`subagent_model_pending`),不唤醒、
 * 不给父会话写任何消息;UI 立即显示目标模型(等待期间也显示),下次该子代理
 * 真实唤醒时 host drain 写入 `model/selection`(用户定案 A)。
 *
 * 视觉:严格照抄 `ModelSelect.module.css`,颜色/圆角/阴影全走 `--dsw-*`
 * token;图标/Input/Toast/MenuSurface 用 primitives 根导出(宿主已注入)。
 */

import React, {
  useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseFillRegular,
  IconDataOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  MenuSurface,
  StateDot,
  Toast,
  rankByName,
} from "@deepseek-ai/dsh-client-ui-primitives";

import {
  fetchModelCatalog,
  fetchSubagentPendingSelection,
  selectSubagentModel,
  type SubagentModelCatalog,
  type SubagentModelCatalogEntry,
  type SubagentModelReasoningEffort,
  type SubagentPendingSelection,
} from "./api.js";

// ── 样式(照抄 ModelSelect.module.css;唯一差别是 class 前缀) ────────────

const CSS_ID = "as-one-subagent-model-styles";
const SUBAGENT_MODEL_CSS = `
.asone-submodel-root { min-width:0; position:relative; }
.asone-submodel-trigger { anchor-name:var(--dsh-submodel-anchor); display:flex; align-items:center; gap:4px; min-width:0; max-width:360px; height:28px; padding:0 4px 0 8px; border:none; border-radius:var(--dsw-radius-sm); background:transparent; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:20px; font-weight:400; cursor:pointer; }
.asone-submodel-trigger:hover { background:var(--dsw-alias-interactive-bg-hover); }
.asone-submodel-trigger:focus-visible { outline:none; box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.asone-submodel-trigger:disabled { opacity:.5; cursor:default; }
.asone-submodel-trigger-label { display:var(--dsh-composer-model-text-display,block); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asone-submodel-trigger-effort { display:var(--dsh-composer-model-text-display,block); flex-shrink:1000; color:var(--dsw-alias-label-caption); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asone-submodel-trigger-icon { display:var(--dsh-composer-model-icon-display, none); flex:0 0 auto; }
.asone-submodel-chevron { flex:0 0 auto; color:var(--dsw-alias-label-caption); transition:transform 120ms ease; }
.asone-submodel-chevron-open { transform:rotate(180deg); }
.asone-submodel-menu { box-sizing:border-box; position:fixed; position-anchor:var(--dsh-submodel-anchor); top:max(12px,var(--dsh-frame-overlay-top,12px)); left:12px; right:anchor(right); bottom:calc(anchor(top) + 8px); align-self:safe end; justify-self:safe end; margin:0; z-index:1100; display:flex; flex-direction:column; width:fit-content; height:fit-content; min-width:min(240px,calc(100vw - 24px)); max-width:min(420px,calc(100vw - 24px)); max-height:min(360px,calc(100dvh - 96px)); overflow:hidden; padding:4px; border:0; --dsw-elevation-stroke-color:var(--dsw-alias-border-l1); box-shadow:var(--dsw-elevation-prominent); color:var(--dsw-alias-label-primary); }
.asone-submodel-cell { display:flex; align-items:center; gap:6px; width:100%; min-width:100%; height:34px; padding:0 8px; border:none; border-radius:var(--dsw-radius-md); background:transparent; color:inherit; font:inherit; font-size:13px; line-height:20px; text-align:left; cursor:pointer; }
.asone-submodel-cell:hover, .asone-submodel-cell-active { background:var(--dsw-alias-interactive-bg-hover); }
.asone-submodel-cell-label { flex:0 0 auto; }
.asone-submodel-cell-value { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; color:var(--dsw-alias-label-tertiary); }
.asone-submodel-cell-chevron { flex:0 0 auto; width:12px; height:12px; color:var(--dsw-alias-menu-icon); }
.asone-submodel-search-row { position:relative; flex-shrink:0; margin:2px 0 3px; }
.asone-submodel-search { display:flex; height:auto; padding:5px 7px; border:0 solid transparent; border-radius:var(--dsw-radius-md); background:transparent; }
.asone-submodel-search-with-query { padding-right:34px; }
.asone-submodel-search input { padding:0; font-size:12px; line-height:normal; }
.asone-submodel-search input::placeholder { color:var(--dsw-alias-label-caption); }
.asone-submodel-search-clear { position:absolute; top:50%; right:4px; transform:translateY(-50%); display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:none; border-radius:50%; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.asone-submodel-search-clear:hover { background:var(--dsw-alias-interactive-bg-hover); }
.asone-submodel-groups { max-height:min(280px,calc(100dvh - 200px)); overflow-y:auto; scrollbar-width:thin; }
.asone-submodel-group-label { position:sticky; top:0; z-index:1; padding:6px 8px 4px; color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:16px; font-weight:500; background:var(--dsw-alias-bg-primary); }
.asone-submodel-option { display:flex; align-items:center; gap:6px; width:100%; min-width:100%; min-height:34px; padding:5px 7px; border:none; border-radius:var(--dsw-radius-md); background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.asone-submodel-option:hover, .asone-submodel-option-active { background:var(--dsw-alias-interactive-bg-hover); }
.asone-submodel-option:focus-visible { outline:none; box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.asone-submodel-option:disabled { opacity:.5; cursor:default; }
.asone-submodel-option-copy { flex:1; min-width:0; }
.asone-submodel-model-name { display:block; min-width:0; font-size:13px; line-height:18px; font-weight:400; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asone-submodel-check { display:grid; place-items:center; flex:0 0 14px; color:var(--dsw-alias-label-primary); }
.asone-submodel-check svg { width:14px; height:14px; }
.asone-submodel-badge { margin-left:4px; }
.asone-submodel-status { padding:8px; color:var(--dsw-alias-label-tertiary); font-size:12px; }
.asone-submodel-error { display:flex; align-items:center; gap:6px; padding:8px; color:var(--dsw-alias-label-secondary); font-size:12px; }
.asone-submodel-retry { margin-left:auto; border:none; background:transparent; color:var(--dsw-alias-state-business-primary); cursor:pointer; font:inherit; }
`;

function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(CSS_ID) !== null) return;
  const el = document.createElement("style");
  el.id = CSS_ID;
  el.textContent = SUBAGENT_MODEL_CSS;
  document.head.appendChild(el);
}

// ── props / 投影读取 ────────────────────────────────────────────────────

export type SubagentModelSelectProps = {
  /** 宿主按会话注入(会话作用域 BUILTIN_SOURCE 标准属性)。 */
  sessionId?: string;
  /** 会话投影读取钩子(宿主标准属性)。 */
  useProjection?: (name: string) => unknown;
};

type SubagentIdentity = { mode?: unknown };

type ModelSelectionLike = {
  provider?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
};

type ModelSelectionProjection = {
  next?: ModelSelectionLike;
  lastUsed?: ModelSelectionLike;
};

type Selection = { provider: string; model: string; reasoningEffort?: string };

/** `subagent` 投影只在 continuation 子代理会话里给出 mode='continuable'。 */
function isContinuable(projection: unknown): boolean {
  if (projection === null || typeof projection !== "object") return false;
  return (projection as SubagentIdentity).mode === "continuable";
}

/** 当前选择:`next` 优先于 `lastUsed`(与原生徽标/选择器同口径)。 */
function currentSelection(projection: unknown): Selection | null {
  if (projection === null || typeof projection !== "object") return null;
  const typed = projection as ModelSelectionProjection;
  const picked = typed.next ?? typed.lastUsed;
  if (picked === null || picked === undefined) return null;
  const provider = typeof picked.provider === "string" ? picked.provider : "";
  const model = typeof picked.model === "string" ? picked.model : "";
  if (provider === "" || model === "") return null;
  const effort = typeof picked.reasoningEffort === "string" ? picked.reasoningEffort : undefined;
  return effort === undefined ? { provider, model } : { provider, model, reasoningEffort: effort };
}

/** LocalizedText → 可读文本(字符串直接用,字典取 en/当前语言回退)。 */
function resolveText(text: string | Record<string, string> | undefined): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  const locale = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  return text[locale] ?? text[locale.split("-")[0]] ?? text.en ?? Object.values(text)[0] ?? "";
}

function sameSelection(a: Selection | null, b: Selection): boolean {
  return a !== null && a.provider === b.provider && a.model === b.model
    && a.reasoningEffort === b.reasoningEffort;
}

type Pane = "root" | "model" | "effort";

interface EffortChoice {
  key: string;
  effort: string | undefined;
  label: string;
}

// ── 组件 ────────────────────────────────────────────────────────────────

export function SubagentModelSelect({ sessionId, useProjection }: SubagentModelSelectProps) {
  injectStyles();

  const subagentProjection = useProjection?.("subagent");
  const modelProjection = useProjection?.("modelSelection");
  const projectionSelected = currentSelection(modelProjection);

  /**
   * 休眠子代理的待切换选择(as-one SQLite 持久化)。它代表用户最近的切换意图,
   * 优先于 modelSelection 投影显示 —— 这样休眠时切完模型,UI「等待期间」也
   * 立即显示目标模型,真正写入 child Session 延迟到下次真实唤醒时 drain。
   */
  const [pending, setPending] = useState<SubagentPendingSelection | null>(null);
  /**
   * 本地「刚切过模型」的版本号。读取 pending 的异步请求启动时记下版本,
   * 回包时若版本已变(用户在请求飞行中切了模型)就丢弃旧值 —— 否则挂载时
   * 那次 fetch(那时还没 pending)会在切换之后才返回 null,把乐观显示清掉,
   * 表现就是「切换后输入框又看不到目标模型」。
   */
  const pendingWriteSeq = useRef(0);

  // 会话切换时重新读取该子代理的 pending 选择。
  useEffect(() => {
    const sid = sessionId ?? "";
    if (sid === "") {
      setPending(null);
      return;
    }
    let cancelled = false;
    const writeSeqAtStart = pendingWriteSeq.current;
    void fetchSubagentPendingSelection(sid)
      .then((value) => {
        if (cancelled || pendingWriteSeq.current !== writeSeqAtStart) return;
        setPending(value);
      })
      .catch(() => {
        if (cancelled || pendingWriteSeq.current !== writeSeqAtStart) return;
        setPending(null);
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  /**
   * 进入子代理页(或切换子代理)就主动拉目录,不等打开菜单。trigger 上的
   * `model.name` 与思考强度 `name` 都来自目录:不预加载的话 `currentChoice`
   * 恒为 undefined,只能显示小写 model id(`free`)且思考强度空白,看起来像
   * 「进页不刷新」。会话切换时 `modelSelection` 投影由宿主推送,这里只负责
   * 补齐「id → 可读名称」的映射。原生每次 show 也会 reload,故 show() 里
   * 仍会再拉一次刷新。
   */
  const continuable = isContinuable(subagentProjection);
  useEffect(() => {
    if (!continuable) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void fetchModelCatalog()
      .then((value) => { if (!cancelled) setCatalog(value); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalog(null);
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, continuable]);

  const selected: Selection | null = pending !== null
    ? {
        provider: pending.provider,
        model: pending.model,
        ...(pending.reasoningEffort === undefined ? {} : { reasoningEffort: pending.reasoningEffort }),
      }
    : projectionSelected;

  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("root");
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [catalog, setCatalog] = useState<SubagentModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null);
  const toastSeq = useRef(0);
  // 会话 id 变了(切到别的子代理)就关掉菜单,避免拿 A 的目录给 B 用。
  const sidRef = useRef(sessionId ?? "");
  useEffect(() => {
    if (sidRef.current !== (sessionId ?? "")) {
      sidRef.current = sessionId ?? "";
      setOpen(false);
      setCatalog(null);
      setQuery("");
    }
  }, [sessionId]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // primitives 的 Input 不转发 ref:包一层拿 DOM,再查内部 input 聚焦。
  const searchWrapRef = useRef<HTMLDivElement | null>(null);
  const focusSearch = (): void => { searchWrapRef.current?.querySelector("input")?.focus(); };
  const id = useId().replaceAll(":", "");
  // CSS 锚点:菜单贴在触发按钮上方(portal 到 body 后 position-anchor 仍能跨树定位)。
  const anchorStyle = {
    "--dsh-submodel-anchor": `--dsh-submodel-${id}`,
  } as CSSProperties;

  // 打开时拉一次目录(原生每次 show 都 reload)。
  const load = (): void => {
    setLoadError(null);
    setLoading(true);
    void fetchModelCatalog()
      .then(setCatalog)
      .catch((err: unknown) => {
        setCatalog(null);
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) === true) return;
      if (menuRef.current?.contains(target) === true) return;
      setOpen(false);
      setPane("root");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const groups = catalog?.groups ?? [];
  const choices = useMemo(
    () => groups.flatMap((group) => group.models.map((model) => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...(model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort }),
      } satisfies Selection,
    }))),
    [groups],
  );
  const showSearch = choices.length > 4;
  const filteredGroups = useMemo(
    () => groups.map((group) => ({
      ...group,
      models: rankByName(group.models, showSearch ? query.trim() : ""),
    })).filter((group) => group.models.length > 0),
    [groups, query, showSearch],
  );
  const visibleModels = useMemo(
    () => filteredGroups.flatMap((group) => group.models.map((model) => ({
      provider: group.id, model: model.id,
    }))),
    [filteredGroups],
  );

  const currentChoice = choices.find((c) =>
    selected !== null && c.selection.provider === selected.provider && c.selection.model === selected.model);
  const reasoning = currentChoice?.model.reasoning;
  const effectiveEffort = selected?.reasoningEffort ?? reasoning?.defaultEffort;
  const effortLabel = currentChoice === undefined
    ? undefined
    : reasoning === undefined
      ? selected?.reasoningEffort
      : effectiveEffort === undefined
        ? "default"
        : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort;
  const effortChoices: EffortChoice[] = reasoning === undefined
    ? []
    : [
      ...(reasoning.defaultEffort === undefined
        ? [{ key: "provider-default", effort: undefined, label: "default" }]
        : []),
      ...reasoning.efforts.map((level: SubagentModelReasoningEffort) => ({
        key: `effort:${level.id}`, effort: level.id, label: level.name,
      })),
    ];

  const modelLabel = currentChoice?.model.name ?? (selected?.model ?? "选择模型");
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`;

  const close = (): void => {
    setOpen(false);
    setPane("root");
  };

  const show = (): void => {
    setQuery("");
    setHighlighted(0);
    setPane(currentChoice === undefined ? "model" : "root");
    setOpen(true);
    load();
    if (currentChoice !== undefined) {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  };

  const submit = (selection: Selection): void => {
    if (sameSelection(selected, selection)) {
      close();
      return;
    }
    if (sessionId === undefined || sessionId === "") return;
    setBusy(true);
    void selectSubagentModel(
      sessionId,
      selection.provider,
      selection.model,
      selection.reasoningEffort,
    )
      .then(() => {
        // 立即把目标模型设为显示态(等待期间显示):运行态由投影同步,休眠态
        // 由 pending 驱动。乐观写入 pending,避免等待投影/drain 的闪烁。
        // 先递增版本号,让挂载时在途的 pending fetch 回包作废,否则它会用旧
        // 的 null 覆盖这里的乐观显示(表现为「切换后输入框又看不到模型」)。
        pendingWriteSeq.current += 1;
        setPending({
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        });
        close();
      })
      .catch((err: unknown) => {
        toastSeq.current += 1;
        setToast({
          seq: toastSeq.current,
          text: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setBusy(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        if (pane !== "root") setPane("root");
        else close();
      }
      return;
    }
    if (!open) return;
    if (pane === "model" && showSearch
      && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      if (visibleModels.length > 0) {
        const dir = event.key === "ArrowDown" ? 1 : -1;
        const next = (highlighted + dir + visibleModels.length) % visibleModels.length;
        setHighlighted(next);
        focusSearch();
      }
      return;
    }
    if (pane === "model" && showSearch && event.target instanceof HTMLInputElement
      && event.key === "Enter") {
      const pick = visibleModels[highlighted];
      if (pick !== undefined) {
        event.preventDefault();
        const group = groups.find((g) => g.id === pick.provider);
        const model = group?.models.find((m) => m.id === pick.model);
        if (model !== undefined) {
          submit({
            provider: pick.provider,
            model: pick.model,
            ...(model.reasoning?.defaultEffort === undefined
              ? {}
              : { reasoningEffort: model.reasoning.defaultEffort }),
          });
        }
      }
    }
  };

  // 只有 continuation 子代理会话才渲染 —— 与用户 m01636 的选择一致。
  if (!isContinuable(subagentProjection)) return null;

  return (
    <div
      ref={rootRef}
      className="asone-submodel-root"
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target instanceof Element && event.target.closest("button") !== null) {
          event.preventDefault();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="asone-submodel-trigger"
        style={anchorStyle}
        aria-label={`模型:${triggerLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerLabel}
        aria-busy={busy}
        onClick={() => { if (open) close(); else show(); }}
      >
        <IconDataOutlineRegular className="asone-submodel-trigger-icon" size={16} />
        <span className="asone-submodel-trigger-label">{modelLabel}</span>
        {effortLabel !== undefined && (
          <span className="asone-submodel-trigger-effort">{effortLabel}</span>
        )}
        {busy
          ? <StateDot state="ongoing" />
          : (
            <IconChevronDownOutlineRegular
              className={`asone-submodel-chevron${open ? " asone-submodel-chevron-open" : ""}`}
            />
          )}
      </button>

      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className="asone-submodel-menu"
          role={pane === "model" ? "group" : "menu"}
          aria-label="选择模型"
          aria-busy={loading || busy}
          style={anchorStyle}
        >
          {pane === "root" && (
            <>
              <button type="button" role="menuitem" className="asone-submodel-cell"
                onClick={() => { setQuery(""); setHighlighted(0); setPane("model"); }}>
                <span className="asone-submodel-cell-label">模型</span>
                <span className="asone-submodel-cell-value">{modelLabel}</span>
                <IconChevronRightOutlineRegular className="asone-submodel-cell-chevron" />
              </button>
              {reasoning !== undefined && (
                <button type="button" role="menuitem" className="asone-submodel-cell"
                  onClick={() => setPane("effort")}>
                  <span className="asone-submodel-cell-label">思考强度</span>
                  <span className="asone-submodel-cell-value">{effortLabel ?? ""}</span>
                  <IconChevronRightOutlineRegular className="asone-submodel-cell-chevron" />
                </button>
              )}
            </>
          )}

          {pane === "model" && (
            <>
              {showSearch && (
                <div className="asone-submodel-search-row" ref={searchWrapRef}>
                  <Input
                    className={`asone-submodel-search${query !== "" ? " asone-submodel-search-with-query" : ""}`}
                    type="text"
                    role="searchbox"
                    placeholder="搜索模型…"
                    aria-label="搜索模型"
                    value={query}
                    readOnly={busy}
                    onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }}
                  />
                  {query !== "" && (
                    <button type="button" className="asone-submodel-search-clear"
                      aria-label="清除" disabled={busy}
                      onClick={() => { setQuery(""); setHighlighted(0); focusSearch(); }}>
                      <IconCloseFillRegular />
                    </button>
                  )}
                </div>
              )}
              {loading && <div className="asone-submodel-status">加载中…</div>}
              {loadError !== null && !loading && (
                <div className="asone-submodel-error">
                  <span>{loadError}</span>
                  <button type="button" className="asone-submodel-retry" onClick={load}>重试</button>
                </div>
              )}
              {catalog?.failures.map((failure) => (
                <div className="asone-submodel-error" key={failure.id}>
                  <span>{failure.name}:{failure.message}</span>
                </div>
              ))}
              <div className="asone-submodel-groups">
                {filteredGroups.map((group) => (
                  <div key={group.id}>
                    <div className="asone-submodel-group-label" style={{ background: "var(--dsw-alias-bg-primary)" }}>
                      {group.name}
                    </div>
                    {group.models.map((model) => {
                      const selection: Selection = {
                        provider: group.id,
                        model: model.id,
                        ...(model.reasoning?.defaultEffort === undefined
                          ? {}
                          : { reasoningEffort: model.reasoning.defaultEffort }),
                      };
                      const isSelected = sameSelection(selected, selection);
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          className="asone-submodel-option"
                          title={model.name}
                          disabled={busy}
                          key={model.id}
                          onClick={() => submit(selection)}
                        >
                          <span className="asone-submodel-option-copy">
                            <span className="asone-submodel-model-name">
                              {model.badge === undefined ? model.name : (
                                <>
                                  {resolveText(model.badge.text)}
                                  <span className="asone-submodel-badge">{model.name}</span>
                                </>
                              )}
                            </span>
                          </span>
                          <span className="asone-submodel-check">
                            {isSelected ? <IconCheckOutlineRegular /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              {catalog !== null && !loading && filteredGroups.length === 0 && (
                <div className="asone-submodel-empty" role="status">没有匹配的模型</div>
              )}
            </>
          )}

          {pane === "effort" && (
            <div className="asone-submodel-groups">
              {effortChoices.length === 0
                ? <div className="asone-submodel-empty">没有可选的思考强度</div>
                : effortChoices.map((level) => {
                  const isCurrent = selected !== null
                    && selected.provider === (currentChoice?.selection.provider ?? "")
                    && selected.model === (currentChoice?.selection.model ?? "")
                    && effectiveEffort === level.effort;
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrent}
                      className="asone-submodel-option"
                      key={level.key}
                      disabled={busy}
                      onClick={() => {
                        if (selected === null) return;
                        submit({
                          provider: selected.provider,
                          model: selected.model,
                          ...(level.effort === undefined ? {} : { reasoningEffort: level.effort }),
                        });
                      }}
                    >
                      <span className="asone-submodel-option-copy">
                        <span className="asone-submodel-model-name">{level.label}</span>
                      </span>
                      <span className="asone-submodel-check">
                        {isCurrent ? <IconCheckOutlineRegular /> : null}
                      </span>
                    </button>
                  );
                })}
            </div>
          )}
        </MenuSurface>,
        document.body,
      )}

      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>("[data-composer-card]") ?? null}
          onDone={() => setToast(null)}
        />
      )}
    </div>
  );
}

