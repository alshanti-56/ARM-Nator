{
  "targets": [
    {
      "target_name": "embedded_mpv",
      "sources": [
        "src/embedded_mpv.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!(node -e \"process.stdout.write(process.env.LIBMPV_INCLUDE_DIR || '')\")",
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
      "target_conditions": [
        [
          "OS==\"mac\"",
          {
            "xcode_settings": {
              "MACOSX_DEPLOYMENT_TARGET": "26.0"
            }
          }
        ]
      ],
      "libraries": [
        "-framework AppKit",
        "-framework CoreVideo",
        "-framework Foundation",
        "-framework OpenGL",
        "<!(node -e \"const path = require('path'); const dir = process.env.LIBMPV_LIBRARY_DIR; process.stdout.write(dir ? path.join(dir, 'libmpv.2.dylib') : '')\")"
      ]
    },
    {
      "target_name": "ksplayer_metal",
      "sources": [
        "src/ksplayer_metal.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
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
          "-Wl,-rpath,@loader_path/ksplayer-metal"
        ]
      },
      "target_conditions": [
        [
          "OS==\"mac\"",
          {
            "xcode_settings": {
              "MACOSX_DEPLOYMENT_TARGET": "26.0"
            }
          }
        ]
      ],
      "libraries": [
        "-framework AppKit",
        "-framework Foundation"
      ]
    }
  ]
}
