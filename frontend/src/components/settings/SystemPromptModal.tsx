import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { useAppContext } from "@/context/AppContext";
import { useTranslation } from "@/i18n";
import { getComposedPrompts, saveComposedPrompt } from "@/api/settings";
import type { ComposedPromptsResponse, PromptSection } from "@/api/settings";

<<<<<<< HEAD
type TabKey = 'agent' | 'full' | 'plan' | 'tool_retrieval';

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'agent', label: 'Agent System Prompt', hint: 'Used for direct chat without a plan.' },
  { key: 'full', label: 'Execution Prompt', hint: 'Used during plan step execution (Role + Plan + Code/CodeGen + Protocol + Resources).' },
  { key: 'plan', label: 'Plan Creation Prompt', hint: 'Used when generating a new research plan.' },
  { key: 'tool_retrieval', label: 'Tool Retrieval', hint: 'Used to select relevant tools before step execution. Variables in {brackets} are filled at runtime.' },
=======
type TabKey = "agent" | "full" | "plan" | "tool_retrieval";

const TABS: { key: TabKey; label: string; hint: string }[] = [
  {
    key: "agent",
    label: "Agent System Prompt",
    hint: "Used for direct chat without a plan.",
  },
  {
    key: "full",
    label: "Execution Prompt",
    hint: "Used during plan step execution (Role + Plan + Code/CodeGen + Protocol + Resources).",
  },
  {
    key: "plan",
    label: "Plan Creation Prompt",
    hint: "Used when generating a new research plan.",
  },
  {
    key: "tool_retrieval",
    label: "Tool Retrieval",
    hint: "Used to select relevant tools before step execution. Variables in {brackets} are filled at runtime.",
  },
>>>>>>> 064c1ba3e0e3069e5c3e5d438c7fb44144593902
];

function SectionsView({ sections }: { sections: PromptSection[] }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const toggle = (i: number) =>
    setExpanded((prev) => ({ ...prev, [i]: !prev[i] }));

  return (
    <div className="sp-sections">
      {sections.map((sec, i) => (
        <div key={i} className="sp-section">
          <button className="sp-section-header" onClick={() => toggle(i)}>
            <span className="sp-section-arrow">{expanded[i] ? "▼" : "▶"}</span>
            <span className="sp-section-label">{sec.label}</span>
          </button>
          {expanded[i] && (
            <pre className="sp-section-content">{sec.content}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

export function SystemPromptModal() {
  const { dispatch } = useAppContext();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabKey>("agent");
  const [composed, setComposed] = useState<ComposedPromptsResponse | null>(
    null,
  );
  const [modelName, setModelName] = useState("");
  const [modeEdits, setModeEdits] = useState<Record<string, string>>({});
  // Separate top/bottom edits for tool_retrieval 3-part layout
  const [retrievalTop, setRetrievalTop] = useState('');
  const [retrievalBottom, setRetrievalBottom] = useState('');
  const [loading, setLoading] = useState(false);

  // Load composed prompts (generated with current model's token_format)
  useEffect(() => {
    if (composed) return;
    setLoading(true);
    getComposedPrompts()
      .then((data) => {
        setComposed(data);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setModelName((data as any).model || "");
        const edits: Record<string, string> = {};
<<<<<<< HEAD
        for (const key of ['full', 'agent', 'plan', 'tool_retrieval'] as const) {
          const d = data[key];
          if (!d) continue;
          if (key === 'tool_retrieval') {
            // 3-part: load top/bottom separately
            setRetrievalTop(d.editable_top || '');
            setRetrievalBottom(d.editable_bottom || '');
            // modeEdits stores the combined form for save
            edits[key] = (d.editable_top || '') + '\n===AUTO_TOOLS===\n' + (d.editable_bottom || '');
=======
        for (const key of [
          "full",
          "agent",
          "plan",
          "tool_retrieval",
        ] as const) {
          const d = data[key];
          if (!d) continue;
          if (key === "tool_retrieval") {
            // For tool_retrieval, edit only the instruction part
            edits[key] = d.custom || d.editable_instruction || d.composed;
>>>>>>> 064c1ba3e0e3069e5c3e5d438c7fb44144593902
          } else {
            edits[key] = d.custom || d.composed;
          }
        }
        setModeEdits(edits);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [composed]);

  const close = () => dispatch({ type: "CLOSE_MODAL" });

  const handleSave = useCallback(async () => {
    try {
      await saveComposedPrompt(activeTab, modeEdits[activeTab] || "");
      close();
    } catch {
      /* silent */
    }
  }, [activeTab, modeEdits]);

  const handleReset = useCallback(() => {
    if (!composed) return;
    const tabData = composed[activeTab];
    if (!tabData) return;
<<<<<<< HEAD
    if (activeTab === 'tool_retrieval') {
      // Reset to defaults (not custom)
      const defaultTop = tabData.default_top || tabData.editable_top || '';
      const defaultBottom = tabData.default_bottom || tabData.editable_bottom || '';
      setRetrievalTop(defaultTop);
      setRetrievalBottom(defaultBottom);
      setModeEdits(prev => ({ ...prev, [activeTab]: '' }));
    } else {
      setModeEdits(prev => ({ ...prev, [activeTab]: tabData.composed }));
    }
=======
    const defaultPrompt =
      activeTab === "tool_retrieval"
        ? tabData.editable_instruction || tabData.composed
        : tabData.composed;
    setModeEdits((prev) => ({ ...prev, [activeTab]: defaultPrompt }));
>>>>>>> 064c1ba3e0e3069e5c3e5d438c7fb44144593902
  }, [activeTab, composed]);

  const handleModeEdit = (value: string) => {
    setModeEdits((prev) => ({ ...prev, [activeTab]: value }));
  };

<<<<<<< HEAD
  const currentTab = TABS.find(tb => tb.key === activeTab)!;
  const modeData = composed ? composed[activeTab] ?? null : null;
=======
  const currentTab = TABS.find((tb) => tb.key === activeTab)!;
  const modeData = composed ? (composed[activeTab] ?? null) : null;
>>>>>>> 064c1ba3e0e3069e5c3e5d438c7fb44144593902

  return (
    <div className="modal active" onClick={close}>
      <div
        className="modal-content modal-content-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{t("label.system_prompt")}</h3>
          {modelName && <span className="sp-model-badge">{modelName}</span>}
          <button className="modal-close" onClick={close}>
            <X size={18} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="sp-tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`sp-tab${activeTab === tab.key ? " sp-tab-active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          <p className="system-prompt-hint">{currentTab.hint}</p>

          {loading ? (
            <div className="sp-loading">Loading...</div>
          ) : modeData ? (
            <>
              <details className="sp-sections-details">
                <summary className="sp-sections-summary">
                  Default Sections
                </summary>
                <SectionsView sections={modeData.sections} />
              </details>
<<<<<<< HEAD
              {activeTab === 'tool_retrieval' && modeData.readonly_middle ? (
                <>
                  <textarea
                    className="modal-textarea"
                    value={retrievalTop}
                    onChange={(e) => {
                      setRetrievalTop(e.target.value);
                      setModeEdits(prev => ({ ...prev, tool_retrieval: e.target.value + '\n===AUTO_TOOLS===\n' + retrievalBottom }));
                    }}
                    rows={6}
=======
              {activeTab === "tool_retrieval" && modeData.readonly_part ? (
                <>
                  <textarea
                    className="modal-textarea"
                    value={modeEdits[activeTab] || ""}
                    onChange={(e) => handleModeEdit(e.target.value)}
                    rows={4}
>>>>>>> 064c1ba3e0e3069e5c3e5d438c7fb44144593902
                  />
                  <p className="system-prompt-hint" style={{ marginTop: 8 }}>
                    The following section is auto-generated from the tool
                    database and cannot be edited.
                  </p>
<<<<<<< HEAD
                  <pre className="sp-readonly-block">{modeData.readonly_middle}</pre>
                  <textarea
                    className="modal-textarea"
                    value={retrievalBottom}
                    onChange={(e) => {
                      setRetrievalBottom(e.target.value);
                      setModeEdits(prev => ({ ...prev, tool_retrieval: retrievalTop + '\n===AUTO_TOOLS===\n' + e.target.value }));
                    }}
                    rows={8}
                    style={{ marginTop: 8 }}
                  />
=======
                  <pre className="sp-readonly-block">
                    {modeData.readonly_part}
                  </pre>
>>>>>>> 064c1ba3e0e3069e5c3e5d438c7fb44144593902
                </>
              ) : (
                <textarea
                  className="modal-textarea"
                  value={modeEdits[activeTab] || ""}
                  onChange={(e) => handleModeEdit(e.target.value)}
                  rows={14}
                />
              )}
            </>
          ) : (
            <div className="sp-loading">No data available</div>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-cancel" onClick={handleReset}>
            {t("label.reset_default")}
          </button>
          <div style={{ flex: 1 }} />
          <button className="modal-btn modal-btn-cancel" onClick={close}>
            {t("label.cancel")}
          </button>
          <button className="modal-btn modal-btn-save" onClick={handleSave}>
            {t("label.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
