#include <ass/ass.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    int top;
    int bottom;
} Bounds;

static const char *script_header =
    "[Script Info]\n"
    "ScriptType: v4.00+\n"
    "PlayResX: 1920\n"
    "PlayResY: 1080\n"
    "[V4+ Styles]\n"
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
    "Style: Default,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1\n"
    "[Events]\n"
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    "Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,";

static ASS_Track *make_track(ASS_Library *library, const char *text)
{
    size_t header_length = strlen(script_header);
    size_t text_length = strlen(text);
    char *script = malloc(header_length + text_length + 1);
    if (!script)
        return NULL;
    memcpy(script, script_header, header_length);
    memcpy(script + header_length, text, text_length + 1);
    ASS_Track *track = ass_read_memory(library, script, header_length + text_length, NULL);
    free(script);
    return track;
}

static Bounds render_bounds(ASS_Renderer *renderer, ASS_Track *track, int position)
{
    Bounds bounds = { .top = INT_MAX, .bottom = INT_MIN };
    int changed = 0;
    ass_set_line_position(renderer, 100 - position);
    for (ASS_Image *image = ass_render_frame(renderer, track, 1000, &changed);
         image; image = image->next) {
        if (image->w <= 0 || image->h <= 0)
            continue;
        if (image->dst_y < bounds.top)
            bounds.top = image->dst_y;
        if (image->dst_y + image->h > bounds.bottom)
            bounds.bottom = image->dst_y + image->h;
    }
    return bounds;
}

static int check_position_range(ASS_Library *library, ASS_Renderer *renderer)
{
    const int heights[] = { 270, 720, 1080 };
    const int positions[] = { 0, 1, 5, 10, 11, 50, 90, 100 };
    const int expected_bottoms[] = { 270, 717, 1065 };
    int failures = 0;

    for (size_t h = 0; h < sizeof(heights) / sizeof(heights[0]); h++) {
        for (int lines = 1; lines <= 3; lines++) {
            const char *text = lines == 1
                ? "One subtitle line"
                : lines == 2
                    ? "First subtitle line\\NSecond subtitle line"
                    : "First subtitle line\\NSecond subtitle line\\NThird subtitle line";
            ASS_Track *track = make_track(library, text);
            if (!track) {
                fprintf(stderr, "FAIL: could not create %d-line subtitle track\n", lines);
                return failures + 1;
            }

            ass_set_frame_size(renderer, heights[h] * 16 / 9, heights[h]);
            ass_set_storage_size(renderer, 1920, 1080);
            int previous_top = -1;
            for (size_t p = 0; p < sizeof(positions) / sizeof(positions[0]); p++) {
                Bounds bounds = render_bounds(renderer, track, positions[p]);
                if (bounds.top == INT_MAX) {
                    fprintf(stderr, "FAIL: no rendered image at height=%d lines=%d position=%d\n",
                            heights[h], lines, positions[p]);
                    failures++;
                    continue;
                }
                if (bounds.top <= previous_top) {
                    fprintf(stderr, "FAIL: position did not move upward-to-downward at height=%d lines=%d position=%d top=%d previous=%d\n",
                            heights[h], lines, positions[p], bounds.top, previous_top);
                    failures++;
                }
                previous_top = bounds.top;
                if (positions[p] == 100 && abs(bounds.bottom - expected_bottoms[h]) > 2) {
                    fprintf(stderr, "FAIL: bottom endpoint changed at height=%d lines=%d: bottom=%d expected about %d\n",
                            heights[h], lines, bounds.bottom, expected_bottoms[h]);
                    failures++;
                }
            }
            ass_free_track(track);
        }
    }
    return failures;
}

static int check_explicit_position(ASS_Library *library, ASS_Renderer *renderer)
{
    ASS_Track *track = make_track(library, "{\\pos(960,540)}Explicitly positioned subtitle");
    if (!track) {
        fprintf(stderr, "FAIL: could not create explicit-position subtitle track\n");
        return 1;
    }

    ass_set_frame_size(renderer, 1280, 720);
    ass_set_storage_size(renderer, 1920, 1080);
    Bounds at_top = render_bounds(renderer, track, 0);
    Bounds at_bottom = render_bounds(renderer, track, 100);
    ass_free_track(track);

    if (at_top.top == INT_MAX || at_bottom.top == INT_MAX ||
        at_top.top != at_bottom.top || at_top.bottom != at_bottom.bottom) {
        fprintf(stderr, "FAIL: ASS \\pos placement changed with slider (0%%: %d..%d, 100%%: %d..%d)\n",
                at_top.top, at_top.bottom, at_bottom.top, at_bottom.bottom);
        return 1;
    }
    return 0;
}

int main(void)
{
    ASS_Library *library = ass_library_init();
    if (!library) {
        fprintf(stderr, "FAIL: ass_library_init failed\n");
        return 1;
    }
    ASS_Renderer *renderer = ass_renderer_init(library);
    if (!renderer) {
        fprintf(stderr, "FAIL: ass_renderer_init failed\n");
        ass_library_done(library);
        return 1;
    }
    ass_set_fonts(renderer, NULL, "Arial", ASS_FONTPROVIDER_CORETEXT, NULL, 1);

    int failures = check_position_range(library, renderer);
    failures += check_explicit_position(library, renderer);
    ass_renderer_done(renderer);
    ass_library_done(library);
    if (failures) {
        fprintf(stderr, "%d subtitle position regression checks failed\n", failures);
        return 1;
    }
    puts("PASS: subtitle position uses the full available range; bottom alignment and ASS \\pos are preserved.");
    return 0;
}
