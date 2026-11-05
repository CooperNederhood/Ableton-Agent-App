cmake_minimum_required(VERSION 3.28)
project(listener_mel_native LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
option(MEL_SANITIZE "ASan and UBSan for offline tests" OFF)
if(MEL_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

# No upstream top-level core build: it fetches unpinned main dependencies that
# are irrelevant to these two header-only algorithms. Only Memory is compiled.
set(DEPS "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/.native-mel/dependencies")
set(FOONATHAN_MEMORY_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(FOONATHAN_MEMORY_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(FOONATHAN_MEMORY_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
add_subdirectory("${DEPS}/memory" "${CMAKE_BINARY_DIR}/memory")
add_library(mel_core INTERFACE)
target_include_directories(mel_core INTERFACE "${CMAKE_CURRENT_SOURCE_DIR}")
target_include_directories(mel_core SYSTEM INTERFACE
  "${DEPS}/core/include" "${DEPS}/eigen" "${DEPS}/hiss/include"
  "${DEPS}/memory/include/foonathan" "${CMAKE_BINARY_DIR}/memory/src")
target_compile_definitions(mel_core INTERFACE EIGEN_MPL2_ONLY=1 EIGEN_RUNTIME_NO_MALLOC)
target_link_libraries(mel_core INTERFACE foonathan_memory)
if(APPLE)
  target_link_libraries(mel_core INTERFACE "-framework Accelerate")
endif()

enable_testing()
add_executable(mel_engine_test tests/engine_test.cpp)
target_link_libraries(mel_engine_test PRIVATE mel_core)
target_compile_options(mel_engine_test PRIVATE -UNDEBUG)
add_test(NAME mel_engine COMMAND mel_engine_test)
add_executable(mel_stream_driver tests/stream_driver.cpp)
target_link_libraries(mel_stream_driver PRIVATE mel_core)
target_compile_options(mel_stream_driver PRIVATE -UNDEBUG)
find_program(NODE_EXECUTABLE node REQUIRED)
add_test(NAME source_binding
  COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/source-binding.mjs"
          "$<TARGET_FILE:mel_stream_driver>")

if(APPLE AND NOT MEL_SANITIZE)
  set(SDK "${DEPS}/max-sdk-base/c74support")
  add_library(listener_mel MODULE max_external.cpp)
  target_link_libraries(listener_mel PRIVATE mel_core
    "${SDK}/msp-includes/MaxAudioAPI.framework")
  target_include_directories(listener_mel PRIVATE
    "${SDK}/max-includes" "${SDK}/msp-includes")
  target_link_options(listener_mel PRIVATE "-undefined" "dynamic_lookup"
    "-Wl,-exported_symbol,_ext_main")
  set_target_properties(listener_mel PROPERTIES
    PREFIX "" OUTPUT_NAME "listener.mel~" BUNDLE TRUE BUNDLE_EXTENSION "mxo"
    CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in")
  # Carry verbatim dependency notices with the built bundle. Do not copy SDK
  # frameworks or distribute a changed/unpinned upstream source tree.
  set(NOTICES "${CMAKE_CURRENT_BINARY_DIR}/listener.mel~.mxo/Contents/Resources/licenses")
  configure_file("${DEPS}/core/LICENSE.md" "${NOTICES}/flucoma-BSD3.txt" COPYONLY)
  configure_file("${DEPS}/hiss/LICENSE" "${NOTICES}/HISSTools-BSD3.txt" COPYONLY)
  configure_file("${DEPS}/eigen/COPYING.MPL2" "${NOTICES}/Eigen-MPL2.txt" COPYONLY)
  configure_file("${DEPS}/memory/LICENSE" "${NOTICES}/foonathan-zlib.txt" COPYONLY)
  configure_file("${DEPS}/max-sdk-base/LICENSE.md" "${NOTICES}/Max-SDK-license.txt" COPYONLY)
  configure_file("${CMAKE_CURRENT_SOURCE_DIR}/dependencies.json"
                 "${NOTICES}/source-pins.json" COPYONLY)
endif()
