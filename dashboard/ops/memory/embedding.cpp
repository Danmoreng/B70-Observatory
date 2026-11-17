// Adapted from BetterSearch native/embedding.cpp, commit 327d8c87 (MIT).
// Retrieval prefix, mean pooling, normalization and model pins remain compatible.
#include "llama.h"
#include "ggml-backend.h"
#include "json.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
using json = nlohmann::json;
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    llama_log_set([](ggml_log_level level, const char *text, void *) {
        if (level >= GGML_LOG_LEVEL_WARN) std::cerr << text;
    }, nullptr);
    llama_backend_init();
    auto mp = llama_model_default_params();
    ggml_backend_dev_t cpu[] = {nullptr};
    mp.n_gpu_layers = 0;
    mp.devices = cpu;
    auto *model = llama_model_load_from_file(argv[1], mp);
    if (!model || llama_model_n_embd_out(model) != 768) return 3;
    auto cp = llama_context_default_params();
    cp.n_ctx = cp.n_batch = cp.n_ubatch = 4096;
    cp.n_seq_max = 1;
    cp.embeddings = true;
    cp.pooling_type = LLAMA_POOLING_TYPE_MEAN;
    cp.attention_type = LLAMA_ATTENTION_TYPE_NON_CAUSAL;
    cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
    cp.offload_kqv = cp.op_offload = false;
    cp.n_threads = cp.n_threads_batch = 2;
    auto *ctx = llama_init_from_model(model, cp);
    if (!ctx) { llama_model_free(model); return 4; }
    auto *vocab = llama_model_get_vocab(model);
    std::cout << json({{"ready",true},{"backend","cpu"},{"dimensions",768}}).dump() << std::endl;
    for (std::string line; std::getline(std::cin, line);) {
        json id = nullptr;
        try {
            if (line.size() > 65536) throw std::runtime_error("Embedding request too large");
            auto request = json::parse(line);
            id = request.at("id");
            auto text = request.at("text").get<std::string>();
            if (text.empty() || text.size() > 32768) throw std::runtime_error("Invalid embedding text");
            if (request.value("query", false)) text = "task: search result | query: " + text;
            std::vector<llama_token> tokens(4096);
            int n = llama_tokenize(vocab, text.c_str(), static_cast<int>(text.size()), tokens.data(), 4096, true, false);
            if (n <= 0 || n > 4096) throw std::runtime_error("Embedding token limit exceeded");
            auto start = std::chrono::steady_clock::now();
            auto batch = llama_batch_init(n, 0, 1);
            batch.n_tokens = n;
            for (int j=0; j<n; ++j) {
                batch.token[j]=tokens[j]; batch.pos[j]=j;
                batch.n_seq_id[j]=1; batch.seq_id[j][0]=0; batch.logits[j]=1;
            }
            llama_memory_clear(llama_get_memory(ctx), true);
            int rc = llama_model_has_encoder(model) ? llama_encode(ctx,batch) : llama_decode(ctx,batch);
            llama_batch_free(batch);
            if (rc) throw std::runtime_error("Embedding evaluation failed");
            const float *raw=llama_get_embeddings_seq(ctx,0);
            if (!raw) throw std::runtime_error("Missing embedding");
            std::vector<float> vector(raw,raw+768);
            double norm=0;
            for(float x:vector) { if(!std::isfinite(x)) throw std::runtime_error("Non-finite embedding"); norm+=x*x; }
            if(norm<1e-12) throw std::runtime_error("Empty embedding");
            for(auto &x:vector) x=static_cast<float>(x/std::sqrt(norm));
            auto ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
            std::cout << json({{"id",id},{"embedding",vector},{"tokens",n},{"durationMs",ms},{"backend","cpu"}}).dump() << std::endl;
        } catch(const std::exception &error) {
            std::cout << json({{"id",id},{"error",error.what()}}).dump() << std::endl;
        }
    }
    llama_free(ctx); llama_model_free(model); llama_backend_free();
}
