/*
 * Headless macOS GL context for the frame-copy helper.
 * Accelerated CGL 3.2 core context; GL entry points for mpv come
 * from the OpenGL framework via dlsym.
 *
 * Threading contract: create() runs on the main thread and must leave the
 * context unbound; the render thread calls makeCurrent() once and owns the
 * context until destroy().
 */
#pragma once

#include <string>


#define GL_SILENCE_DEPRECATION
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>

#include <dlfcn.h>


namespace frame_helper {

/* Matches mpv_opengl_init_params.get_proc_address. */
using GlGetProcAddressFn = void* (*)(void* ctx, const char* name);


inline void* glDlsymGetProcAddress(void* ctx, const char* name) {
    return dlsym(ctx, name);
}

class GlContext {
public:
    bool create(std::string& errorOut) {
        glDylib_ = dlopen(
            "/System/Library/Frameworks/OpenGL.framework/Versions/Current/"
            "OpenGL",
            RTLD_LAZY | RTLD_LOCAL);
        if (!glDylib_) {
            errorOut = "failed to open the OpenGL framework";
            return false;
        }

        CGLPixelFormatAttribute attrs[] = {
            kCGLPFAOpenGLProfile,
            (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
            kCGLPFAAccelerated,
            kCGLPFAColorSize, (CGLPixelFormatAttribute)24,
            kCGLPFAAlphaSize, (CGLPixelFormatAttribute)8,
            (CGLPixelFormatAttribute)0,
        };
        CGLPixelFormatObj pixelFormat = nullptr;
        GLint matched = 0;
        if (CGLChoosePixelFormat(attrs, &pixelFormat, &matched) !=
                kCGLNoError ||
            !pixelFormat) {
            errorOut = "no accelerated CGL pixel format";
            return false;
        }
        const CGLError contextError =
            CGLCreateContext(pixelFormat, nullptr, &cgl_);
        CGLDestroyPixelFormat(pixelFormat);
        if (contextError != kCGLNoError || !cgl_) {
            errorOut = "failed to create a headless CGL context";
            return false;
        }
        return true;
    }

    bool makeCurrent(std::string& errorOut) {
        if (CGLSetCurrentContext(cgl_) != kCGLNoError) {
            errorOut = "failed to bind the CGL render context";
            return false;
        }
        return true;
    }

    void destroy() {
        CGLSetCurrentContext(nullptr);
        if (cgl_) CGLDestroyContext(cgl_);
        cgl_ = nullptr;
        /* glDylib_ stays mapped: mpv may still resolve symbols during its
         * own teardown, and the process exits right after anyway. */
    }

    GlGetProcAddressFn procLoader() const { return glDlsymGetProcAddress; }
    void* procLoaderCtx() const { return glDylib_; }
    const char* renderApiName() const { return "cgl"; }

private:
    CGLContextObj cgl_ = nullptr;
    void* glDylib_ = nullptr;
};


} // namespace frame_helper
