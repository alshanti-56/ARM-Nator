export interface PlayerSubtitleSettings {
    /** Relative subtitle size. 100 is the engine default. */
    fontSize: number;
    /** Subtitle foreground color in #RRGGBB form. */
    textColor: string;
    /** Subtitle background color in #RRGGBB form. */
    backgroundColor: string;
    /** Background opacity from 0 to 100. */
    backgroundOpacity: number;
    /** Outline width from 0 to 6. */
    outlineSize: number;
    /** Vertical position from 0 (top) to 100 (bottom). */
    position: number;
    /** Subtitle timing offset in seconds. */
    delaySeconds: number;
}
