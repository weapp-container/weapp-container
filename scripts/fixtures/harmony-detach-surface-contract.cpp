// Compile the unchanged production retirement function at a fault-injected
// EGL boundary. No driver/window/device acceptance is implied.
#include <cassert>
#include <cstdint>
#include <string>
#include <set>
using EGLint = int;
constexpr int EGL_NO_DISPLAY=0,EGL_NO_SURFACE=0,EGL_NO_CONTEXT=0,EGL_TRUE=1;
constexpr int EGL_CONTEXT_LOST=10,EGL_BAD_CONTEXT=11,EGL_BAD_SURFACE=12,EGL_BAD_DISPLAY=13,EGL_NOT_INITIALIZED=14,EGL_BAD_ALLOC=15;
constexpr int WEAPP_CONTAINER_FFI_OK=0,WEAPP_CONTAINER_FFI_ERR=-1;
struct WeappContainerFfiBuffer { void* data; size_t len; };
struct HostState {
  void* host=reinterpret_cast<void*>(1);int display=2,surface=11,context=3;void* config=reinterpret_cast<void*>(4);
  void* nativeWindow=reinterpret_cast<void*>(5);bool rustContextAttached=true;
  uint32_t surfaceWidth=375,surfaceHeight=667;
};
int scenario=0,errorCode=0,terminated=0,windows=0,abandoned=0;
std::set<int> surfaces{11,21},contexts{3,4};
int eglGetError(){return errorCode;}
std::string EglError(const char* operation,EGLint error=eglGetError()){return std::string(operation)+std::to_string(error);}
int eglMakeCurrent(int display,int,int,int){assert(display==2);return EGL_TRUE;}
int eglDestroySurface(int display,int surface){assert(display==2);if(scenario==1){errorCode=EGL_BAD_ALLOC;return 0;}assert(surfaces.erase(surface)==1);return EGL_TRUE;}
int eglDestroyContext(int display,int context){assert(display==2);assert(contexts.erase(context)==1);return EGL_TRUE;}
int eglTerminate(int){++terminated;return EGL_TRUE;}
void OH_NativeWindow_DestroyNativeWindow(void*){++windows;}
int weapp_container_harmony_host_detach_gles_context(void*,WeappContainerFfiBuffer*){return scenario>=2?WEAPP_CONTAINER_FFI_ERR:WEAPP_CONTAINER_FFI_OK;}
int weapp_container_harmony_host_abandon_gles_context(void*){++abandoned;return scenario==2?WEAPP_CONTAINER_FFI_ERR:WEAPP_CONTAINER_FFI_OK;}
void weapp_container_harmony_buffer_free(WeappContainerFfiBuffer*){}
#include "detach_surface.inc"
int main(int argc,char** argv){
  assert(argc==2);scenario=std::stoi(argv[1]);HostState owner,sibling;sibling.surface=21;sibling.context=4;
  auto result=DetachSurface(&owner);
  if(scenario==1){assert(!result.empty());assert(owner.surface==11&&owner.context==0&&owner.display==2&&owner.nativeWindow!=nullptr);scenario=0;assert(DetachSurface(&owner).empty());}
  else if(scenario==2){assert(!result.empty());assert(owner.surface==11&&owner.context==3&&owner.rustContextAttached);scenario=0;assert(DetachSurface(&owner).empty());}
  else assert(result.empty());
  assert(owner.surface==0&&owner.context==0&&owner.display==0&&owner.nativeWindow==nullptr&&!owner.rustContextAttached);
  assert(terminated==0&&windows==1);assert(surfaces.count(21)==1&&contexts.count(4)==1);
  assert(DetachSurface(&owner).empty());assert(windows==1);
  assert(DetachSurface(&sibling).empty());assert(terminated==0&&windows==2&&surfaces.empty()&&contexts.empty());
}
