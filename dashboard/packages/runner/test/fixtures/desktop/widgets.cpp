#include <QApplication>
#include <QFile>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QShortcut>
#include <QWidget>

int main(int argc, char **argv) {
  QApplication app(argc, argv);
  QWidget window;
  window.setWindowTitle("B70 Native Widgets");
  window.resize(640, 420);
  QLineEdit input(&window);
  input.setGeometry(20, 30, 560, 40);
  QPushButton button("Save text", &window);
  button.setGeometry(20, 90, 230, 55);
  QLabel status("Enter text and save", &window);
  status.setGeometry(20, 165, 580, 45);
  auto save = [&]() {
    QFile file("widgets-saved.txt");
    if (!file.open(QIODevice::WriteOnly)) { status.setText("Save failed"); return; }
    file.write(input.text().toUtf8());
    file.close();
    status.setText("Saved: " + input.text());
  };
  QObject::connect(&button, &QPushButton::clicked, save);
  QShortcut shortcut(QKeySequence::Save, &window);
  QObject::connect(&shortcut, &QShortcut::activated, save);
  window.show();
  return app.exec();
}
