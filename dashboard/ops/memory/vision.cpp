// Pinned llama.cpp multimodal batch API; private CPU image embedding helper.
#include "llama.h"
#include "ggml-backend.h"
#include "mtmd.h"
#include "mtmd-helper.h"
#include "json.hpp"
#include <cmath>
#include <iostream>
#include <vector>
#include <stdexcept>
#include <chrono>
using json=nlohmann::json;
int main(int argc,char**argv){
 if(argc!=3)return 2;
 auto log=[](ggml_log_level level,const char*text,void*){if(level>=GGML_LOG_LEVEL_WARN)std::cerr<<text;};
 llama_log_set(log,nullptr);mtmd_helper_log_set(log,nullptr);llama_backend_init();
 auto mp=llama_model_default_params();ggml_backend_dev_t cpu[]={nullptr};mp.devices=cpu;mp.n_gpu_layers=0;
 auto*model=llama_model_load_from_file(argv[1],mp);if(!model||llama_model_n_embd_out(model)!=768)return 3;
 auto cp=llama_context_default_params();cp.n_ctx=cp.n_batch=cp.n_ubatch=4096;cp.n_seq_max=1;cp.embeddings=true;cp.pooling_type=LLAMA_POOLING_TYPE_MEAN;cp.attention_type=LLAMA_ATTENTION_TYPE_NON_CAUSAL;cp.flash_attn_type=LLAMA_FLASH_ATTN_TYPE_DISABLED;cp.offload_kqv=cp.op_offload=false;cp.n_threads=cp.n_threads_batch=2;
 auto*ctx=llama_init_from_model(model,cp);if(!ctx)return 4;
 auto vp=mtmd_context_params_default();vp.use_gpu=false;vp.n_threads=2;vp.warmup=false;vp.image_max_tokens=280;
 auto*vision=mtmd_init_from_file(argv[2],model,vp);if(!vision)return 5;
 std::cout<<json({{"ready",true},{"backend","cpu"},{"dimensions",768}}).dump()<<std::endl;
 for(std::string line;std::getline(std::cin,line);){json id=nullptr;
  try{if(line.size()>65536)throw std::runtime_error("Request too large");auto req=json::parse(line);id=req.at("id");auto path=req.at("imagePath").get<std::string>();
   auto t0=std::chrono::steady_clock::now();auto bitmap=mtmd_helper_bitmap_init_from_file(vision,path.c_str(),false,mtmd_helper_init_opt_default());if(!bitmap.bitmap)throw std::runtime_error("Invalid image");
   auto*chunks=mtmd_input_chunks_init();auto*batch=llama_batch_ext_init(ctx);
   try{mtmd_input_part part{nullptr,bitmap.bitmap};const mtmd_input_part*parts[]={&part};if(mtmd_tokenize_from_parts(vision,chunks,parts,1,true))throw std::runtime_error("Image preprocessing failed");
    llama_pos pos=0;const size_t n=mtmd_input_chunks_size(chunks);std::vector<std::vector<float>> visual;visual.reserve(n);
    auto add=[&](int idx){if(idx<0||pos>=4096)throw std::runtime_error("Image token budget exceeded");llama_batch_ext_set_pos(batch,idx,&pos);llama_batch_ext_set_output_embd(batch,idx,true);pos++;};
    for(size_t i=0;i<n;i++){auto*c=mtmd_input_chunks_get(chunks,i);auto type=mtmd_input_chunk_get_type(c);
     if(type==MTMD_INPUT_CHUNK_TYPE_TEXT){size_t count;auto*t=mtmd_input_chunk_get_tokens_text(c,&count);for(size_t j=0;j<count;j++)add(llama_batch_ext_add_token(batch,0,t[j]));}
     else if(type==MTMD_INPUT_CHUNK_TYPE_IMAGE){if(mtmd_encode_chunk(vision,c))throw std::runtime_error("Vision encoder failed");size_t count=mtmd_input_chunk_get_n_tokens(c);int dim=llama_model_n_embd_inp(model);auto*raw=mtmd_get_output_embd(vision);visual.emplace_back(raw,raw+count*dim);for(size_t j=0;j<count;j++)add(llama_batch_ext_add_embd(batch,0,{visual.back().data()+j*dim,1,(size_t)dim}));}
     else throw std::runtime_error("Only still images are supported");
    }
    llama_memory_clear(llama_get_memory(ctx),true);if(llama_process(ctx,LLAMA_PROCESS_TYPE_DECODE,batch))throw std::runtime_error("Image embedding failed");
    auto*raw=llama_get_embeddings_seq(ctx,0);if(!raw)throw std::runtime_error("Missing pooled image embedding");std::vector<float> out(raw,raw+768);double norm=0;for(float x:out){if(!std::isfinite(x))throw std::runtime_error("Nonfinite image embedding");norm+=x*x;}if(norm<1e-12)throw std::runtime_error("Empty image embedding");for(auto&x:out)x/=std::sqrt(norm);
    std::cout<<json({{"id",id},{"embedding",out},{"tokens",pos},{"durationMs",std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count()}}).dump()<<std::endl;
   }catch(...){llama_batch_ext_free(batch);mtmd_input_chunks_free(chunks);mtmd_bitmap_free(bitmap.bitmap);throw;}
   llama_batch_ext_free(batch);mtmd_input_chunks_free(chunks);mtmd_bitmap_free(bitmap.bitmap);
  }catch(const std::exception&e){std::cout<<json({{"id",id},{"error",e.what()}}).dump()<<std::endl;}
 }
 mtmd_free(vision);llama_free(ctx);llama_model_free(model);llama_backend_free();
}
