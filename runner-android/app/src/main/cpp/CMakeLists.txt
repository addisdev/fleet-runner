cmake_minimum_required(VERSION 3.22)
project(fleetllama CXX)

set(LLAMA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../third_party/llama.cpp)

set(BUILD_SHARED_LIBS OFF)
set(LLAMA_BUILD_TESTS OFF)
set(LLAMA_BUILD_TOOLS OFF)
set(LLAMA_BUILD_EXAMPLES OFF)
set(LLAMA_BUILD_SERVER OFF)
set(LLAMA_CURL OFF)
# ggml's own threadpool behaves better than NDK OpenMP on big.LITTLE.
set(GGML_OPENMP OFF)

add_subdirectory(${LLAMA_DIR} llama-build)

add_library(fleetllama SHARED fleet_llama.cpp)
target_link_libraries(fleetllama PRIVATE llama log)
