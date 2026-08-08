#ifndef ARM_NATOR_KSPLAYER_METAL_RUNTIME_H
#define ARM_NATOR_KSPLAYER_METAL_RUNTIME_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * ABI v1 is intentionally a small UTF-8/opaque-pointer boundary. Every
 * operation returns an owned UTF-8 JSON object; callers release it through
 * ksplayer_metal_free_string. No Swift, AppKit, or KSPlayer types cross this
 * boundary.
 */
const char* ksplayer_metal_abi_version(void);
char* ksplayer_metal_get_support(void);
char* ksplayer_metal_prepare(void);
char* ksplayer_metal_create_session(
    const char* session_id,
    void* electron_parent_view,
    double x,
    double y,
    double width,
    double height
);
char* ksplayer_metal_load(
    const char* session_id,
    const char* url,
    const char* headers_json
);
char* ksplayer_metal_set_bounds(
    const char* session_id,
    double x,
    double y,
    double width,
    double height
);
char* ksplayer_metal_set_paused(const char* session_id, int paused);
char* ksplayer_metal_seek(const char* session_id, double seconds);
char* ksplayer_metal_set_volume(const char* session_id, double volume);
char* ksplayer_metal_set_audio_track(const char* session_id, double track_id);
char* ksplayer_metal_set_subtitle_track(const char* session_id, double track_id);
char* ksplayer_metal_set_subtitle_file(const char* session_id, const char* file_path);
char* ksplayer_metal_set_subtitle_settings(const char* session_id, const char* settings_json);
char* ksplayer_metal_set_playback_speed(const char* session_id, double speed);
char* ksplayer_metal_get_supported_controls(const char* session_id);
char* ksplayer_metal_get_snapshot(const char* session_id);
char* ksplayer_metal_dispose_session(const char* session_id);
char* ksplayer_metal_dispose_all(void);
void ksplayer_metal_free_string(char* value);

#ifdef __cplusplus
}
#endif

#endif
