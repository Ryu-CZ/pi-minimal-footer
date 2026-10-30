import { CustomEditor, type CustomEditorOptions, type ExtensionUIContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

/** Only the separator belongs to us; input, completion and scrolling remain Pi's. */
export class CompactEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options: CustomEditorOptions,
    private readonly renderLine: (width: number, borderColor: EditorTheme["borderColor"]) => string | undefined,
  ) {
    super(tui, theme, keybindings, options);
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    const original = super.renderBottomBorder(width, hiddenLineCount);
    if (hiddenLineCount > 0) return original;
    const line = this.renderLine(width, this.borderColor);
    if (line === undefined || line === "") return original;
    const overlay = truncateToWidth(line, width, "");
    const overlayWidth = visibleWidth(overlay);
    return overlayWidth < width ? overlay + sliceByColumn(original, overlayWidth, width) : overlay;
  }
}

/** Never replace another extension's editor, including after a later takeover. */
export class CompactEditorController {
  private ownedFactory: EditorFactory | undefined;
  private ui: ExtensionUIContext | undefined;
  private renderLine: ((width: number, borderColor: EditorTheme["borderColor"]) => string) | undefined;

  isActive(): boolean {
    return !!this.renderLine && !!this.ownedFactory && this.ui?.getEditorComponent() === this.ownedFactory;
  }

  install(ui: ExtensionUIContext, renderLine: (width: number, borderColor: EditorTheme["borderColor"]) => string): void {
    this.renderLine = renderLine;
    if (this.ownedFactory) return;
    if (ui.getEditorComponent() !== undefined) return;
    this.ui = ui;
    this.ownedFactory = (tui, theme, keybindings) => new CompactEditor(
      tui, theme, keybindings, { embedWorkingStatus: true },
      (width, borderColor) => this.isActive() ? this.renderLine?.(width, borderColor) : undefined,
    );
    this.swapEditor(ui, this.ownedFactory);
  }

  deactivate(): void { this.renderLine = undefined; }

  dispose(): void {
    this.deactivate();
    if (this.ownedFactory && this.ui?.getEditorComponent() === this.ownedFactory) {
      this.swapEditor(this.ui, undefined);
    }
    this.ownedFactory = undefined;
    this.ui = undefined;
  }

  private swapEditor(ui: ExtensionUIContext, factory: EditorFactory | undefined): void {
    // The host copies marker text, not the outgoing editor's private paste store.
    const expanded = ui.getEditorText();
    ui.setEditorComponent(factory);
    if (ui.getEditorText() !== expanded) ui.setEditorText(expanded);
  }
}
