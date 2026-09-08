// Reader quick-adjust panel — the in-reader surface for on-the-fly appearance
// changes, for BOTH reader families:
//
//   variant "reflow" (EPUB / scraped novels) → typography controls
//   variant "fixed"  (PDF / DOCX)            → flow / fit / tint / zoom
//
// Everything around those controls — the shell, the language row, the theme
// row, the "All settings" footer — is shared, so the two readers can't drift
// into feeling like different apps. The controls themselves come from
// components/SettingsSection.tsx, the same module the full Settings page
// renders from (same components, same `Tweaks` state).

import { Icon } from "../components/Icon";
import {
  ActionRow,
  FixedPageControls,
  LanguageField,
  ReadingControls,
  ThemeField,
} from "../components/SettingsSection";
import type { Theme, ThemeKey } from "../styles/tokens";
import type { Tweaks } from "../types/reader";
import { PanelShell } from "./PanelShell";
import { useI18n } from "../i18n/useI18n";
import type { UiLangPref } from "../i18n";

interface BaseProps {
  theme: Theme;
  themeKey: ThemeKey;
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  onClose?: () => void;
  width?: number | string;
  side?: "left" | "right";
  /** Surface mobile-only fields (e.g. tap-to-turn-pages) and size touch
      targets for a finger. The desktop reader doesn't show the mobile-only
      fields because they have no effect there. */
  mobile?: boolean;
  /** Navigate to the full Settings page. When provided, a footer link is shown. */
  onOpenFullSettings?: () => void;
}

/** `zoom` is per-session viewer state owned by FixedPageReader rather than a
 *  `Tweaks` field, so the fixed variant takes it explicitly — and the union
 *  makes omitting it a compile error. */
type Props =
  | (BaseProps & { variant?: "reflow"; zoom?: never; onZoomChange?: never })
  | (BaseProps & {
      variant: "fixed";
      zoom: number;
      onZoomChange: (next: number) => void;
    });

export function SettingsPanel(props: Props) {
  const {
    theme,
    t,
    setTweak,
    onClose,
    width,
    side = "right",
    mobile,
    onOpenFullSettings,
  } = props;
  const { tr } = useI18n();
  // Narrow off `props` (not a destructured copy) so TypeScript carries the
  // discriminant into the branch below and knows `zoom` is present there.
  const fixed = props.variant === "fixed";
  return (
    <PanelShell
      theme={theme}
      title={tr("settings.title")}
      subtitle={fixed ? tr("settings.subtitle.fixed") : tr("settings.subtitle")}
      onClose={onClose}
      icon={<Icon name="type" size={14} />}
      width={width}
      side={side}
    >
      <LanguageField
        theme={theme}
        value={t.uiLang}
        onChange={(v: UiLangPref) => setTweak("uiLang", v)}
      />
      <ThemeField theme={theme} pref={t.theme} onChange={(p) => setTweak("theme", p)} />
      {props.variant === "fixed" ? (
        <FixedPageControls
          theme={theme}
          t={t}
          setTweak={setTweak}
          zoom={props.zoom}
          onZoomChange={props.onZoomChange}
          mobile={mobile}
        />
      ) : (
        <ReadingControls
          theme={theme}
          t={t}
          setTweak={setTweak}
          showPageTurn={!mobile}
        />
      )}
      {onOpenFullSettings && (
        <ActionRow
          theme={theme}
          icon={<Icon name="settings" size={16} />}
          label={tr("settings.openFull")}
          hint={tr("settings.openFull.hint")}
          onClick={onOpenFullSettings}
          trailing={
            <Icon name="chevronR" size={16} className="rtl-flip-x" style={{ opacity: 0.5 }} />
          }
        />
      )}
    </PanelShell>
  );
}
