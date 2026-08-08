#include <napi.h>

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <filesystem>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

constexpr const char* kBackendName = "ksplayer-metal";
constexpr const char* kExpectedAbiVersion = "1";

extern "C" void ksplayerMetalModuleAnchor() {}

using AbiVersionFunction = const char* (*)();
using JsonFunction = char* (*)();
using CreateSessionFunction = char* (*)(
    const char*,
    void*,
    double,
    double,
    double,
    double
);
using LoadFunction = char* (*)(const char*, const char*, const char*);
using StringFunction = char* (*)(const char*, const char*);
using SetBoundsFunction = char* (*)(const char*, double, double, double, double);
using SetPausedFunction = char* (*)(const char*, int);
using NumberFunction = char* (*)(const char*, double);
using SessionFunction = char* (*)(const char*);
using FreeStringFunction = void (*)(char*);

struct RuntimeApi {
    AbiVersionFunction abiVersion = nullptr;
    JsonFunction getSupport = nullptr;
    JsonFunction prepare = nullptr;
    CreateSessionFunction createSession = nullptr;
    LoadFunction load = nullptr;
    SetBoundsFunction setBounds = nullptr;
    SetPausedFunction setPaused = nullptr;
    NumberFunction seek = nullptr;
    NumberFunction setVolume = nullptr;
    NumberFunction setAudioTrack = nullptr;
    NumberFunction setSubtitleTrack = nullptr;
    StringFunction setSubtitleFile = nullptr;
    StringFunction setSubtitleSettings = nullptr;
    StringFunction setDisplayMode = nullptr;
    NumberFunction setPlaybackSpeed = nullptr;
    SessionFunction getSupportedControls = nullptr;
    SessionFunction getSnapshot = nullptr;
    SessionFunction disposeSession = nullptr;
    JsonFunction disposeAll = nullptr;
    // Additive diagnostic symbols. They remain optional so a v1 runtime
    // without either diagnostic stays loadable by the production addon.
    JsonFunction diagnoseEmbedding = nullptr;
    SessionFunction getEmbeddingDiagnostic = nullptr;
    FreeStringFunction freeString = nullptr;
};

std::string architectureName()
{
#if defined(__aarch64__) || defined(__arm64__)
    return "arm64";
#else
    return "unsupported";
#endif
}

std::string jsonEscape(const std::string& input)
{
    std::ostringstream output;
    for (const unsigned char character : input) {
        switch (character) {
            case '\\':
                output << "\\\\";
                break;
            case '"':
                output << "\\\"";
                break;
            case '\b':
                output << "\\b";
                break;
            case '\f':
                output << "\\f";
                break;
            case '\n':
                output << "\\n";
                break;
            case '\r':
                output << "\\r";
                break;
            case '\t':
                output << "\\t";
                break;
            default:
                if (character < 0x20) {
                    constexpr char hex[] = "0123456789abcdef";
                    output << "\\u00" << hex[character >> 4]
                           << hex[character & 0x0f];
                } else {
                    output << static_cast<char>(character);
                }
                break;
        }
    }
    return output.str();
}

std::string operationErrorJson(
    const std::string& reason,
    const std::optional<std::string>& sessionId = std::nullopt
)
{
    std::ostringstream output;
    output << "{\"ok\":false,\"backend\":\"" << kBackendName
           << "\",\"reason\":\"" << jsonEscape(reason)
           << "\",\"message\":\"" << jsonEscape(reason) << "\"";
    if (sessionId) {
        output << ",\"sessionId\":\"" << jsonEscape(*sessionId) << "\"";
    }
    output << "}";
    return output.str();
}

std::string snapshotErrorJson(const std::string& reason)
{
    return "{\"backend\":\"ksplayer-metal\",\"state\":\"error\",\"error\":\"" +
        jsonEscape(reason) + "\",\"message\":\"" + jsonEscape(reason) +
        "\"}";
}

std::string supportErrorJson(const std::string& reason)
{
    return "{\"supported\":false,\"reason\":\"" + jsonEscape(reason) +
        "\",\"architecture\":\"" + architectureName() + "\"}";
}

std::string controlsErrorJson(const std::string& reason)
{
    return "{\"pause\":false,\"seek\":false,\"volume\":false,\"audioTracks\":false,\"playbackSpeed\":false,\"reason\":\"" +
        jsonEscape(reason) + "\"}";
}

std::filesystem::path addonPath()
{
    Dl_info info{};
    if (dladdr(reinterpret_cast<void*>(&ksplayerMetalModuleAnchor), &info) != 0 &&
        info.dli_fname) {
        return std::filesystem::path(info.dli_fname);
    }
    return {};
}

std::vector<std::filesystem::path> runtimeCandidates()
{
    std::vector<std::filesystem::path> candidates;
    if (const char* overridePath = std::getenv("ARM_NATOR_KSPLAYER_METAL_RUNTIME_PATH")) {
        if (overridePath[0] != '\0') {
            candidates.emplace_back(overridePath);
        }
    }

    const auto modulePath = addonPath();
    if (!modulePath.empty()) {
        candidates.push_back(
            modulePath.parent_path() / "ksplayer-metal" / "KSPlayerMetalRuntime.dylib"
        );
    }

    std::error_code error;
    const auto currentPath = std::filesystem::current_path(error);
    if (!error) {
        candidates.push_back(
            currentPath / "apps" / "electron-backend" / "native" / "build" /
                "Release" / "ksplayer-metal" / "KSPlayerMetalRuntime.dylib"
        );
    }

    std::vector<std::filesystem::path> deduped;
    std::unordered_set<std::string> seen;
    for (const auto& candidate : candidates) {
        const auto normalized = candidate.lexically_normal();
        if (seen.insert(normalized.string()).second) {
            deduped.push_back(normalized);
        }
    }
    return deduped;
}

bool hasRequiredRuntimeLayout(
    const std::filesystem::path& dylibPath,
    std::string& error
)
{
    const auto runtimeRoot = dylibPath.parent_path();
    const auto nativeRoot = runtimeRoot.parent_path();
    const std::vector<std::filesystem::path> requiredPaths = {
        dylibPath,
        runtimeRoot / "Frameworks",
        runtimeRoot / "KSPlayer_KSPlayer.bundle" / "Contents" / "Resources" /
            "default.metallib",
        nativeRoot / "ksplayer-metal-runtime.json",
    };
    for (const auto& path : requiredPaths) {
        std::error_code existsError;
        if (!std::filesystem::exists(path, existsError) || existsError) {
            error = "KSPlayer Metal runtime is incomplete; missing " + path.string();
            return false;
        }
    }
    return true;
}

template <typename Function>
Function resolveSymbol(void* handle, const char* name, std::string& error)
{
    dlerror();
    void* symbol = dlsym(handle, name);
    const char* dlsymError = dlerror();
    if (dlsymError || !symbol) {
        error = "KSPlayer Metal runtime is missing " + std::string(name) +
            ": " + (dlsymError ? dlsymError : "unknown dlsym error");
        return nullptr;
    }
    return reinterpret_cast<Function>(symbol);
}

template <typename Function>
Function resolveOptionalSymbol(void* handle, const char* name)
{
    dlerror();
    void* symbol = dlsym(handle, name);
    // Consume the dlsym error so a missing optional diagnostic cannot affect a
    // later required-symbol lookup.
    (void)dlerror();
    return symbol ? reinterpret_cast<Function>(symbol) : nullptr;
}

class RuntimeLoader {
  public:
    bool ensureLoaded()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (loaded_) {
            return true;
        }
        if (attempted_) {
            return false;
        }
        attempted_ = true;

        if (architectureName() != "arm64") {
            error_ = "KSPlayer Metal requires an arm64 Electron process.";
            return false;
        }

        std::string lastError;
        for (const auto& candidate : runtimeCandidates()) {
            std::error_code existsError;
            if (!std::filesystem::exists(candidate, existsError) || existsError) {
                lastError = "Unable to locate KSPlayer Metal runtime at " + candidate.string();
                continue;
            }
            if (!hasRequiredRuntimeLayout(candidate, lastError)) {
                continue;
            }

            // The Swift runtime must remain private to this addon. In particular,
            // no Swift or FFmpegKit symbols are promoted to Electron's global
            // namespace and no MPV symbol lookup is ever attempted here.
            void* handle = dlopen(candidate.c_str(), RTLD_NOW | RTLD_LOCAL);
            if (!handle) {
                const char* dlopenError = dlerror();
                lastError = "Unable to load KSPlayer Metal runtime at " +
                    candidate.string() + ": " +
                    (dlopenError ? dlopenError : "unknown dlopen error");
                continue;
            }

            RuntimeApi candidateApi;
            std::string symbolError;
            candidateApi.abiVersion =
                resolveSymbol<AbiVersionFunction>(handle, "ksplayer_metal_abi_version", symbolError);
            candidateApi.getSupport =
                resolveSymbol<JsonFunction>(handle, "ksplayer_metal_get_support", symbolError);
            candidateApi.prepare =
                resolveSymbol<JsonFunction>(handle, "ksplayer_metal_prepare", symbolError);
            candidateApi.createSession = resolveSymbol<CreateSessionFunction>(
                handle,
                "ksplayer_metal_create_session",
                symbolError
            );
            candidateApi.load =
                resolveSymbol<LoadFunction>(handle, "ksplayer_metal_load", symbolError);
            candidateApi.setBounds =
                resolveSymbol<SetBoundsFunction>(handle, "ksplayer_metal_set_bounds", symbolError);
            candidateApi.setPaused =
                resolveSymbol<SetPausedFunction>(handle, "ksplayer_metal_set_paused", symbolError);
            candidateApi.seek =
                resolveSymbol<NumberFunction>(handle, "ksplayer_metal_seek", symbolError);
            candidateApi.setVolume =
                resolveSymbol<NumberFunction>(handle, "ksplayer_metal_set_volume", symbolError);
            candidateApi.setAudioTrack = resolveSymbol<NumberFunction>(
                handle,
                "ksplayer_metal_set_audio_track",
                symbolError
            );
            candidateApi.setSubtitleTrack = resolveSymbol<NumberFunction>(
                handle,
                "ksplayer_metal_set_subtitle_track",
                symbolError
            );
            candidateApi.setSubtitleFile = resolveSymbol<StringFunction>(
                handle,
                "ksplayer_metal_set_subtitle_file",
                symbolError
            );
            candidateApi.setSubtitleSettings = resolveSymbol<StringFunction>(
                handle,
                "ksplayer_metal_set_subtitle_settings",
                symbolError
            );
            candidateApi.setPlaybackSpeed = resolveSymbol<NumberFunction>(
                handle,
                "ksplayer_metal_set_playback_speed",
                symbolError
            );
            candidateApi.setDisplayMode = resolveSymbol<StringFunction>(
                handle,
                "ksplayer_metal_set_display_mode",
                symbolError
            );
            candidateApi.getSupportedControls = resolveSymbol<SessionFunction>(
                handle,
                "ksplayer_metal_get_supported_controls",
                symbolError
            );
            candidateApi.getSnapshot = resolveSymbol<SessionFunction>(
                handle,
                "ksplayer_metal_get_snapshot",
                symbolError
            );
            candidateApi.disposeSession = resolveSymbol<SessionFunction>(
                handle,
                "ksplayer_metal_dispose_session",
                symbolError
            );
            candidateApi.disposeAll =
                resolveSymbol<JsonFunction>(handle, "ksplayer_metal_dispose_all", symbolError);
            candidateApi.diagnoseEmbedding = resolveOptionalSymbol<JsonFunction>(
                handle,
                "ksplayer_metal_diagnose_embedding"
            );
            candidateApi.getEmbeddingDiagnostic = resolveOptionalSymbol<SessionFunction>(
                handle,
                "ksplayer_metal_get_embedding_diagnostic"
            );
            candidateApi.freeString = resolveSymbol<FreeStringFunction>(
                handle,
                "ksplayer_metal_free_string",
                symbolError
            );
            if (!symbolError.empty()) {
                dlclose(handle);
                lastError = symbolError;
                continue;
            }

            const char* version = candidateApi.abiVersion();
            if (!version || std::string(version) != kExpectedAbiVersion) {
                dlclose(handle);
                lastError = "KSPlayer Metal runtime ABI version is incompatible.";
                continue;
            }

            handle_ = handle;
            api_ = candidateApi;
            runtimePath_ = candidate.string();
            loaded_ = true;
            error_.clear();
            return true;
        }

        error_ = lastError.empty()
            ? "Unable to locate a KSPlayer Metal runtime."
            : lastError;
        return false;
    }

    const RuntimeApi& api() const { return api_; }
    const std::string& error() const { return error_; }
    const std::string& runtimePath() const { return runtimePath_; }

    std::string invoke(JsonFunction function)
    {
        if (!function) {
            return operationErrorJson("KSPlayer Metal runtime operation is unavailable.");
        }
        @try {
            char* value = function();
            return takeJson(value);
        } @catch (NSException* exception) {
            return operationErrorJson(
                std::string("KSPlayer Metal runtime raised an Objective-C exception: ") +
                (exception.reason.UTF8String ? exception.reason.UTF8String : "unknown")
            );
        }
    }

    std::string invoke(SessionFunction function, const std::string& sessionId)
    {
        if (!function) {
            return operationErrorJson("KSPlayer Metal runtime operation is unavailable.", sessionId);
        }
        @try {
            char* value = function(sessionId.c_str());
            return takeJson(value);
        } @catch (NSException* exception) {
            return operationErrorJson(
                std::string("KSPlayer Metal runtime raised an Objective-C exception: ") +
                    (exception.reason.UTF8String ? exception.reason.UTF8String : "unknown"),
                sessionId
            );
        }
    }

    std::string invoke(
        CreateSessionFunction function,
        const std::string& sessionId,
        void* parentView,
        double x,
        double y,
        double width,
        double height
    )
    {
        if (!function) {
            return operationErrorJson("KSPlayer Metal runtime operation is unavailable.", sessionId);
        }
        @try {
            char* value = function(sessionId.c_str(), parentView, x, y, width, height);
            return takeJson(value);
        } @catch (NSException* exception) {
            return operationErrorJson(
                std::string("KSPlayer Metal runtime raised an Objective-C exception: ") +
                    (exception.reason.UTF8String ? exception.reason.UTF8String : "unknown"),
                sessionId
            );
        }
    }

    std::string invoke(
        LoadFunction function,
        const std::string& sessionId,
        const std::string& url,
        const std::string& headers
    )
    {
        if (!function) {
            return operationErrorJson("KSPlayer Metal runtime operation is unavailable.", sessionId);
        }
        @try {
            char* value = function(sessionId.c_str(), url.c_str(), headers.c_str());
            return takeJson(value);
        } @catch (NSException* exception) {
            return operationErrorJson(
                std::string("KSPlayer Metal runtime raised an Objective-C exception: ") +
                    (exception.reason.UTF8String ? exception.reason.UTF8String : "unknown"),
                sessionId
            );
        }
    }

    std::string invoke(
        StringFunction function,
        const std::string& sessionId,
        const std::string& value
    )
    {
        if (!function) {
            return operationErrorJson("KSPlayer Metal runtime operation is unavailable.", sessionId);
        }
        @try {
            char* response = function(sessionId.c_str(), value.c_str());
            return takeJson(response);
        } @catch (NSException* exception) {
            return operationErrorJson(
                std::string("KSPlayer Metal runtime raised an Objective-C exception: ") +
                    (exception.reason.UTF8String ? exception.reason.UTF8String : "unknown"),
                sessionId
            );
        }
    }

    std::string invoke(
        SetBoundsFunction function,
        const std::string& sessionId,
        double x,
        double y,
        double width,
        double height
    )
    {
        if (!function) {
            return operationErrorJson("KSPlayer Metal runtime operation is unavailable.", sessionId);
        }
        @try {
            char* value = function(sessionId.c_str(), x, y, width, height);
            return takeJson(value);
        } @catch (NSException* exception) {
            return operationErrorJson(
                std::string("KSPlayer Metal runtime raised an Objective-C exception: ") +
                    (exception.reason.UTF8String ? exception.reason.UTF8String : "unknown"),
                sessionId
            );
        }
    }

    std::string invoke(
        SetPausedFunction function,
        const std::string& sessionId,
        bool paused
    )
    {
        if (!function) {
            return operationErrorJson("KSPlayer Metal runtime operation is unavailable.", sessionId);
        }
        @try {
            char* value = function(sessionId.c_str(), paused ? 1 : 0);
            return takeJson(value);
        } @catch (NSException* exception) {
            return operationErrorJson(
                std::string("KSPlayer Metal runtime raised an Objective-C exception: ") +
                    (exception.reason.UTF8String ? exception.reason.UTF8String : "unknown"),
                sessionId
            );
        }
    }

    std::string invoke(
        NumberFunction function,
        const std::string& sessionId,
        double value
    )
    {
        if (!function) {
            return operationErrorJson("KSPlayer Metal runtime operation is unavailable.", sessionId);
        }
        @try {
            char* response = function(sessionId.c_str(), value);
            return takeJson(response);
        } @catch (NSException* exception) {
            return operationErrorJson(
                std::string("KSPlayer Metal runtime raised an Objective-C exception: ") +
                    (exception.reason.UTF8String ? exception.reason.UTF8String : "unknown"),
                sessionId
            );
        }
    }

  private:
    std::string takeJson(char* value)
    {
        if (!value) {
            return operationErrorJson("KSPlayer Metal runtime returned no result.");
        }
        std::string response(value);
        api_.freeString(value);
        return response;
    }

    std::mutex mutex_;
    bool attempted_ = false;
    bool loaded_ = false;
    void* handle_ = nullptr;
    RuntimeApi api_;
    std::string runtimePath_;
    std::string error_;
};

RuntimeLoader& runtimeLoader()
{
    static RuntimeLoader loader;
    return loader;
}

void clearPendingNapiException(napi_env env)
{
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
        napi_value ignored = nullptr;
        napi_get_and_clear_last_exception(env, &ignored);
    }
}

bool parseJson(napi_env env, const std::string& json, napi_value* result)
{
    napi_value global = nullptr;
    napi_value jsonObject = nullptr;
    napi_value parse = nullptr;
    napi_value input = nullptr;
    napi_status status = napi_get_global(env, &global);
    if (status == napi_ok) {
        status = napi_get_named_property(env, global, "JSON", &jsonObject);
    }
    if (status == napi_ok) {
        status = napi_get_named_property(env, jsonObject, "parse", &parse);
    }
    if (status == napi_ok) {
        status = napi_create_string_utf8(env, json.data(), json.size(), &input);
    }
    if (status == napi_ok) {
        status = napi_call_function(env, jsonObject, parse, 1, &input, result);
    }
    if (status != napi_ok || !*result) {
        clearPendingNapiException(env);
        return false;
    }
    return true;
}

Napi::Value parseJsonOrFallback(
    Napi::Env env,
    const std::string& json,
    const std::string& fallback
)
{
    napi_value parsed = nullptr;
    if (parseJson(env, json, &parsed) || parseJson(env, fallback, &parsed)) {
        return Napi::Value(env, parsed);
    }
    return env.Undefined();
}

void setStringProperty(Napi::Env env, Napi::Value value, const char* key, const std::string& string)
{
    if (!value.IsObject()) {
        return;
    }
    napi_value result = value;
    napi_value property = nullptr;
    if (napi_create_string_utf8(env, string.c_str(), string.size(), &property) == napi_ok) {
        napi_set_named_property(env, result, key, property);
    }
}

Napi::Value supportUnavailable(Napi::Env env, const std::string& reason)
{
    return parseJsonOrFallback(env, supportErrorJson(reason), "{}");
}

Napi::Value operationUnavailable(
    Napi::Env env,
    const std::string& reason,
    const std::optional<std::string>& sessionId = std::nullopt
)
{
    return parseJsonOrFallback(env, operationErrorJson(reason, sessionId), "{}");
}

Napi::Value controlsUnavailable(Napi::Env env, const std::string& reason)
{
    return parseJsonOrFallback(env, controlsErrorJson(reason), "{}");
}

Napi::Value snapshotUnavailable(Napi::Env env, const std::string& reason)
{
    return parseJsonOrFallback(env, snapshotErrorJson(reason), "{}");
}

bool readRequiredString(
    const Napi::CallbackInfo& info,
    size_t index,
    std::string& value,
    std::string& error
)
{
    if (info.Length() <= index || !info[index].IsString()) {
        error = "Expected a UTF-8 string argument.";
        return false;
    }
    value = info[index].As<Napi::String>().Utf8Value();
    if (value.empty()) {
        error = "String argument cannot be empty.";
        return false;
    }
    return true;
}

bool readRequiredNumber(
    const Napi::Object& object,
    const char* key,
    double& value,
    std::string& error
)
{
    const Napi::Value candidate = object.Get(key);
    if (!candidate.IsNumber()) {
        error = std::string("Bounds.") + key + " must be a number.";
        return false;
    }
    value = candidate.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(value)) {
        error = std::string("Bounds.") + key + " must be finite.";
        return false;
    }
    return true;
}

bool readBounds(
    const Napi::CallbackInfo& info,
    size_t index,
    double& x,
    double& y,
    double& width,
    double& height,
    std::string& error
)
{
    if (info.Length() <= index || !info[index].IsObject() || info[index].IsArray()) {
        error = "Expected a bounds object with x, y, width, and height.";
        return false;
    }
    const auto bounds = info[index].As<Napi::Object>();
    return readRequiredNumber(bounds, "x", x, error) &&
        readRequiredNumber(bounds, "y", y, error) &&
        readRequiredNumber(bounds, "width", width, error) &&
        readRequiredNumber(bounds, "height", height, error);
}

std::string headersJson(const Napi::CallbackInfo& info, size_t index, std::string& error)
{
    if (info.Length() <= index || info[index].IsUndefined() || info[index].IsNull()) {
        return "{}";
    }
    if (!info[index].IsObject() || info[index].IsArray()) {
        error = "Headers must be an object whose values are strings.";
        return {};
    }
    const auto headers = info[index].As<Napi::Object>();
    const auto keys = headers.GetPropertyNames();
    std::ostringstream output;
    output << "{";
    bool first = true;
    for (uint32_t index = 0; index < keys.Length(); index += 1) {
        const Napi::Value propertyName = keys.Get(index);
        if (!propertyName.IsString()) {
            continue;
        }
        const auto value = headers.Get(propertyName);
        if (!value.IsString()) {
            error = "Headers must be an object whose values are strings.";
            return {};
        }
        if (!first) {
            output << ",";
        }
        first = false;
        output << "\"" << jsonEscape(propertyName.As<Napi::String>().Utf8Value())
               << "\":\"" << jsonEscape(value.As<Napi::String>().Utf8Value()) << "\"";
    }
    output << "}";
    return output.str();
}

bool resolveElectronParentView(
    const Napi::CallbackInfo& info,
    size_t index,
    void*& contentView,
    std::string& error
)
{
    if (info.Length() <= index || !info[index].IsBuffer()) {
        error = "Expected Electron native view handle Buffer.";
        return false;
    }
    const auto nativeHandle = info[index].As<Napi::Buffer<uint8_t>>();
    if (nativeHandle.Length() < sizeof(uintptr_t)) {
        error = "Electron native view handle Buffer is too small.";
        return false;
    }
    uintptr_t rawHandle = 0;
    std::memcpy(
        &rawHandle,
        nativeHandle.Data(),
        std::min(nativeHandle.Length(), sizeof(uintptr_t))
    );
    if (rawHandle == 0) {
        error = "Electron native view handle is empty.";
        return false;
    }

    __block NSView* resolvedView = nil;
    @try {
        void (^resolve)(void) = ^{
          NSView* candidate = (__bridge NSView*)reinterpret_cast<void*>(rawHandle);
          if (!candidate) {
              return;
          }
          // Electron supplies an opaque NSView handle. The Swift runtime lays
          // out the Metal child in BrowserWindow content coordinates, so pass
          // the resolved content view rather than the raw handle.
          resolvedView = candidate.window.contentView ?: candidate;
        };
        if ([NSThread isMainThread]) {
            resolve();
        } else {
            dispatch_sync(dispatch_get_main_queue(), resolve);
        }
    } @catch (NSException* exception) {
        error = std::string("Unable to resolve Electron native view: ") +
            (exception.reason.UTF8String ? exception.reason.UTF8String : "unknown");
        return false;
    }

    if (!resolvedView) {
        error = "Unable to resolve Electron BrowserWindow content view.";
        return false;
    }
    contentView = (__bridge void*)resolvedView;
    return true;
}

Napi::Value GetSupport(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return supportUnavailable(env, runtime.error());
        }
        Napi::Value response = parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().getSupport),
            supportErrorJson("KSPlayer Metal runtime returned malformed support data.")
        );
        setStringProperty(env, response, "runtimePath", runtime.runtimePath());
        return response;
    } catch (const std::exception& exception) {
        return supportUnavailable(info.Env(), exception.what());
    } catch (...) {
        return supportUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value Prepare(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return supportUnavailable(env, runtime.error());
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().prepare),
            supportErrorJson("KSPlayer Metal runtime returned malformed prepare data.")
        );
    } catch (const std::exception& exception) {
        return supportUnavailable(info.Env(), exception.what());
    } catch (...) {
        return supportUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value DiagnoseEmbedding(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error());
        }
        if (!runtime.api().diagnoseEmbedding) {
            return operationUnavailable(
                env,
                "KSPlayer Metal runtime does not expose the embedding diagnostic."
            );
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().diagnoseEmbedding),
            operationErrorJson("KSPlayer Metal embedding diagnostic returned malformed data.")
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value GetEmbeddingDiagnostic(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull()) {
            std::string error;
            if (!readRequiredString(info, 0, sessionId, error)) {
                return operationUnavailable(env, error);
            }
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error());
        }
        if (!runtime.api().getEmbeddingDiagnostic) {
            return operationUnavailable(
                env,
                "KSPlayer Metal runtime does not expose the live embedding diagnostic."
            );
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().getEmbeddingDiagnostic, sessionId),
            operationErrorJson(
                "KSPlayer Metal live embedding diagnostic returned malformed data.",
                sessionId.empty() ? std::nullopt : std::optional<std::string>(sessionId)
            )
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(
            info.Env(),
            "Unknown KSPlayer Metal live embedding diagnostic failure."
        );
    }
}

Napi::Value CreateSession(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error)) {
            return operationUnavailable(env, error);
        }
        void* contentView = nullptr;
        if (!resolveElectronParentView(info, 1, contentView, error)) {
            return operationUnavailable(env, error, sessionId);
        }
        double x = 0;
        double y = 0;
        double width = 0;
        double height = 0;
        if (!readBounds(info, 2, x, y, width, height, error)) {
            return operationUnavailable(env, error, sessionId);
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error(), sessionId);
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(
                runtime.api().createSession,
                sessionId,
                contentView,
                x,
                y,
                width,
                height
            ),
            operationErrorJson("KSPlayer Metal runtime returned malformed session data.", sessionId)
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value Load(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string url;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error) ||
            !readRequiredString(info, 1, url, error)) {
            return operationUnavailable(env, error, sessionId.empty()
                ? std::nullopt
                : std::optional<std::string>(sessionId));
        }
        const std::string headers = headersJson(info, 2, error);
        if (!error.empty()) {
            return operationUnavailable(env, error, sessionId);
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error(), sessionId);
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().load, sessionId, url, headers),
            operationErrorJson("KSPlayer Metal runtime returned malformed load data.", sessionId)
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value SetBounds(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error)) {
            return operationUnavailable(env, error);
        }
        double x = 0;
        double y = 0;
        double width = 0;
        double height = 0;
        if (!readBounds(info, 1, x, y, width, height, error)) {
            return operationUnavailable(env, error, sessionId);
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error(), sessionId);
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().setBounds, sessionId, x, y, width, height),
            operationErrorJson("KSPlayer Metal runtime returned malformed bounds data.", sessionId)
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value SetPaused(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error)) {
            return operationUnavailable(env, error);
        }
        if (info.Length() < 2 || !info[1].IsBoolean()) {
            return operationUnavailable(env, "Paused value must be a boolean.", sessionId);
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error(), sessionId);
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(
                runtime.api().setPaused,
                sessionId,
                info[1].As<Napi::Boolean>().Value()
            ),
            operationErrorJson("KSPlayer Metal runtime returned malformed pause data.", sessionId)
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value InvokeNumberOperation(
    const Napi::CallbackInfo& info,
    bool isSeek,
    bool isPlaybackSpeed,
    bool isSubtitleTrack,
    bool isAudioTrack,
    const char* operation
)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error)) {
            return operationUnavailable(env, error);
        }
        if (info.Length() < 2 || !info[1].IsNumber()) {
            return operationUnavailable(
                env,
                std::string(operation) + " value must be a number.",
                sessionId
            );
        }
        const double value = info[1].As<Napi::Number>().DoubleValue();
        if (!std::isfinite(value)) {
            return operationUnavailable(
                env,
                std::string(operation) + " value must be finite.",
                sessionId
            );
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error(), sessionId);
        }
        const NumberFunction function = isSeek
            ? runtime.api().seek
            : isSubtitleTrack
                ? runtime.api().setSubtitleTrack
            : isAudioTrack
                ? runtime.api().setAudioTrack
            : isPlaybackSpeed
                    ? runtime.api().setPlaybackSpeed
                : runtime.api().setVolume;
        return parseJsonOrFallback(
            env,
            runtime.invoke(function, sessionId, value),
            operationErrorJson(
                std::string("KSPlayer Metal runtime returned malformed ") + operation + " data.",
                sessionId
            )
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value Seek(const Napi::CallbackInfo& info)
{
    return InvokeNumberOperation(info, true, false, false, false, "seek");
}

Napi::Value SetVolume(const Napi::CallbackInfo& info)
{
    return InvokeNumberOperation(info, false, false, false, false, "volume");
}

Napi::Value SetAudioTrack(const Napi::CallbackInfo& info)
{
    return InvokeNumberOperation(info, false, false, false, true, "audio track");
}

Napi::Value SetSubtitleTrack(const Napi::CallbackInfo& info)
{
    return InvokeNumberOperation(info, false, false, true, false, "subtitle track");
}

Napi::Value SetSubtitleFile(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string filePath;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error) ||
            !readRequiredString(info, 1, filePath, error)) {
            return operationUnavailable(env, error, sessionId.empty()
                ? std::nullopt
                : std::optional<std::string>(sessionId));
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error(), sessionId);
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().setSubtitleFile, sessionId, filePath),
            operationErrorJson("KSPlayer Metal runtime returned malformed subtitle data.", sessionId)
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value SetSubtitleSettings(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string settingsJSON;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error) ||
            !readRequiredString(info, 1, settingsJSON, error)) {
            return operationUnavailable(env, error, sessionId.empty()
                ? std::nullopt
                : std::optional<std::string>(sessionId));
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error(), sessionId);
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().setSubtitleSettings, sessionId, settingsJSON),
            operationErrorJson("KSPlayer Metal runtime returned malformed subtitle settings data.", sessionId)
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value SetPlaybackSpeed(const Napi::CallbackInfo& info)
{
    return InvokeNumberOperation(info, false, true, false, false, "playback speed");
}

Napi::Value SetDisplayMode(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string mode;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error) ||
            !readRequiredString(info, 1, mode, error)) {
            return operationUnavailable(env, error, sessionId.empty()
                ? std::nullopt
                : std::optional<std::string>(sessionId));
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error(), sessionId);
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().setDisplayMode, sessionId, mode),
            operationErrorJson("KSPlayer Metal runtime returned malformed display-mode data.", sessionId)
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value GetSupportedControls(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull()) {
            std::string error;
            if (!readRequiredString(info, 0, sessionId, error)) {
                return controlsUnavailable(env, error);
            }
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return controlsUnavailable(env, runtime.error());
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().getSupportedControls, sessionId),
            controlsErrorJson("KSPlayer Metal runtime returned malformed controls data.")
        );
    } catch (const std::exception& exception) {
        return controlsUnavailable(info.Env(), exception.what());
    } catch (...) {
        return controlsUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value GetSnapshot(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error)) {
            return snapshotUnavailable(env, error);
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return snapshotUnavailable(env, runtime.error());
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().getSnapshot, sessionId),
            snapshotErrorJson("KSPlayer Metal runtime returned malformed snapshot data.")
        );
    } catch (const std::exception& exception) {
        return snapshotUnavailable(info.Env(), exception.what());
    } catch (...) {
        return snapshotUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value DisposeSession(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        std::string sessionId;
        std::string error;
        if (!readRequiredString(info, 0, sessionId, error)) {
            return operationUnavailable(env, error);
        }
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error(), sessionId);
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().disposeSession, sessionId),
            operationErrorJson("KSPlayer Metal runtime returned malformed dispose data.", sessionId)
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Value DisposeAll(const Napi::CallbackInfo& info)
{
    try {
        const auto env = info.Env();
        auto& runtime = runtimeLoader();
        if (!runtime.ensureLoaded()) {
            return operationUnavailable(env, runtime.error());
        }
        return parseJsonOrFallback(
            env,
            runtime.invoke(runtime.api().disposeAll),
            operationErrorJson("KSPlayer Metal runtime returned malformed dispose-all data.")
        );
    } catch (const std::exception& exception) {
        return operationUnavailable(info.Env(), exception.what());
    } catch (...) {
        return operationUnavailable(info.Env(), "Unknown KSPlayer Metal addon failure.");
    }
}

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("getSupport", Napi::Function::New(env, GetSupport));
    exports.Set("prepare", Napi::Function::New(env, Prepare));
    exports.Set("diagnoseEmbedding", Napi::Function::New(env, DiagnoseEmbedding));
    exports.Set(
        "getEmbeddingDiagnostic",
        Napi::Function::New(env, GetEmbeddingDiagnostic)
    );
    exports.Set("createSession", Napi::Function::New(env, CreateSession));
    exports.Set("load", Napi::Function::New(env, Load));
    exports.Set("setBounds", Napi::Function::New(env, SetBounds));
    exports.Set("setPaused", Napi::Function::New(env, SetPaused));
    exports.Set("seek", Napi::Function::New(env, Seek));
    exports.Set("setVolume", Napi::Function::New(env, SetVolume));
    exports.Set("setAudioTrack", Napi::Function::New(env, SetAudioTrack));
    exports.Set("setSubtitleTrack", Napi::Function::New(env, SetSubtitleTrack));
    exports.Set("setSubtitleFile", Napi::Function::New(env, SetSubtitleFile));
    exports.Set("setSubtitleSettings", Napi::Function::New(env, SetSubtitleSettings));
    exports.Set("setPlaybackSpeed", Napi::Function::New(env, SetPlaybackSpeed));
    exports.Set("setDisplayMode", Napi::Function::New(env, SetDisplayMode));
    exports.Set(
        "getSupportedControls",
        Napi::Function::New(env, GetSupportedControls)
    );
    exports.Set("getSnapshot", Napi::Function::New(env, GetSnapshot));
    exports.Set("disposeSession", Napi::Function::New(env, DisposeSession));
    exports.Set("disposeAll", Napi::Function::New(env, DisposeAll));
    return exports;
}

} // namespace

NODE_API_MODULE(ksplayer_metal, Init)
