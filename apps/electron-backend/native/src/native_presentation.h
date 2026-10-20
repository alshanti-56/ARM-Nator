#pragma once
#include <atomic>
#include <cstdint>

// Render completions belong to one load; old callbacks cannot reveal its successor.
class NativePresentation {
    std::atomic<uint64_t> generation{0}, loadedGeneration{0}, presentedGeneration{0};
public:
    void beginLoad() { generation.fetch_add(1); }
    void loaded() { loadedGeneration.store(generation.load()); }
    uint64_t frameToken() const {
        const auto current = generation.load();
        return current != 0 && loadedGeneration.load() == current ? current : 0;
    }
    void presented(uint64_t token) {
        if (token != 0 && frameToken() == token) presentedGeneration.store(token);
    }
    bool ready() const { const auto current = frameToken(); return current != 0 && presentedGeneration.load() == current; }
    void invalidate() { beginLoad(); }
};
