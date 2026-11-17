// Toolkit-independent native window: no widgets, browser or accessibility tree.
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <fstream>
#include <string>

int main() {
  Display *display = XOpenDisplay(nullptr);
  if (!display) return 2;
  int screen = DefaultScreen(display);
  Window window = XCreateSimpleWindow(display, RootWindow(display, screen), 0, 0, 640, 420, 0, 0, 0xf4f4f4);
  XStoreName(display, window, "B70 Native Canvas");
  Atom close = XInternAtom(display, "WM_DELETE_WINDOW", False);
  XSetWMProtocols(display, window, &close, 1);
  XSelectInput(display, window, ExposureMask | ButtonPressMask | KeyPressMask);
  XMapWindow(display, window);
  GC gc = XCreateGC(display, window, 0, nullptr);
  int clicks = 0, scrolls = 0;
  std::string typed;
  bool running = true;
  auto paint = [&]() {
    XClearWindow(display, window);
    XSetForeground(display, gc, clicks ? 0x278a49 : 0xb33f39);
    XFillRectangle(display, window, gc, 20, 50, 230, 65);
    XSetForeground(display, gc, 0xffffff);
    XDrawString(display, window, gc, 35, 85, "Click to turn green", 19);
    XSetForeground(display, gc, 0x202020);
    std::string label = "Clicks: " + std::to_string(clicks) + " | Scrolls: " + std::to_string(scrolls);
    XDrawString(display, window, gc, 20, 155, label.c_str(), label.size());
    label = "Typed: " + typed;
    XDrawString(display, window, gc, 20, 195, label.c_str(), label.size());
    XFlush(display);
  };
  while (running) {
    XEvent event;
    XNextEvent(display, &event);
    if (event.type == ClientMessage && static_cast<Atom>(event.xclient.data.l[0]) == close) running = false;
    if (event.type == ButtonPress) {
      if (event.xbutton.button == 1 && event.xbutton.x >= 20 && event.xbutton.x <= 250 && event.xbutton.y >= 50 && event.xbutton.y <= 115) ++clicks;
      if (event.xbutton.button == 4 || event.xbutton.button == 5) ++scrolls;
    }
    if (event.type == KeyPress) {
      char buffer[64];
      KeySym symbol;
      int count = XLookupString(&event.xkey, buffer, sizeof(buffer), &symbol, nullptr);
      if (count > 0) typed.append(buffer, count);
    }
    std::ofstream("canvas-state.txt") << clicks << "\n" << scrolls << "\n" << typed << "\n";
    paint();
  }
  XFreeGC(display, gc);
  XDestroyWindow(display, window);
  XCloseDisplay(display);
}
