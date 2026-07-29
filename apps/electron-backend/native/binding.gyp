{
  "targets": [
    {
      "target_name": "embedded_mpv",
      "sources": [
        "src/embedded_mpv.mm"
      ],
      "include_dirs": [
        "<(module_root_dir)/../../../node_modules/.pnpm/node_modules/node-addon-api",
        "<!(node -e \"if (!process.env.LIBMPV_INCLUDE_DIR) throw new Error('LIBMPV_INCLUDE_DIR is required'); process.stdout.write(process.env.LIBMPV_INCLUDE_DIR)\")",
        "src"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS"
      ],
      "cflags_cc": [
        "-fexceptions",
        "-std=c++20"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "26.0",
        "OTHER_LDFLAGS": [
          "-Wl,-rpath,@loader_path/lib"
        ]
      },
      "libraries": [
        "-framework AppKit",
        "-framework CoreVideo",
        "-framework Foundation",
        "-framework OpenGL",
        "<!(node -e \"const path = require('path'); const dir = process.env.LIBMPV_LIBRARY_DIR; if (!dir) throw new Error('LIBMPV_LIBRARY_DIR is required'); process.stdout.write(path.join(dir, 'libmpv.2.dylib'))\")"
      ]
    },
    {
      "target_name": "embedded_mpv_frame_reader",
      "sources": [
        "src/embedded_mpv_frame_reader.c"
      ],
      "include_dirs": [
        "helper"
      ]
    },
    {
      "target_name": "arm-nator_mpv_helper",
      "type": "executable",
      "sources": [
        "helper/mpv_frame_helper.cpp"
      ],
      "include_dirs": [
        "<!(node -e \"if (!process.env.LIBMPV_INCLUDE_DIR) throw new Error('LIBMPV_INCLUDE_DIR is required'); process.stdout.write(process.env.LIBMPV_INCLUDE_DIR)\")",
        "helper"
      ],
      "cflags_cc": [
        "-std=c++17"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "26.0",
        "OTHER_LDFLAGS": [
          "-Wl,-rpath,@executable_path/lib",
          "-Wl,-rpath,@loader_path/lib"
        ]
      },
      "libraries": [
        "-framework OpenGL",
        "<!(node -e \"const path = require('path'); const dir = process.env.LIBMPV_LIBRARY_DIR; if (!dir) throw new Error('LIBMPV_LIBRARY_DIR is required'); process.stdout.write(path.join(dir, 'libmpv.2.dylib'))\")"
      ]
    }
  ]
}
