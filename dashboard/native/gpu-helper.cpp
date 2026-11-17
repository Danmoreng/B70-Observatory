#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <poll.h>
#include <sstream>
#include <string>
#include <string_view>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <vector>

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

namespace {

constexpr std::string_view kDrmRoot = "/sys/class/drm";
constexpr std::string_view kProcRoot = "/proc";
constexpr std::size_t kMaxPids = 65536;
constexpr std::size_t kMaxFdsPerPid = 8192;
constexpr std::size_t kMaxFdInfoFiles = 131072;
constexpr auto kSampleInterval = std::chrono::seconds(2);
volatile std::sig_atomic_t running = 1;

struct EngineCounter {
  std::uint64_t busy{};
  std::uint64_t total{};
  std::uint64_t capacity{1};
};

struct Client {
  std::uint64_t resident_vram{};
  std::map<std::string, EngineCounter> engines;
};

struct Card {
  std::string name;
  fs::path device;
  std::string pdev;
  std::optional<fs::path> hwmon;
};

struct Previous {
  Clock::time_point at;
  std::optional<std::uint64_t> energy_microjoules;
  std::map<std::string, std::map<std::string, EngineCounter>> clients;
};

std::string trim(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos)
    return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::optional<std::string> read_text(const fs::path &path) {
  std::ifstream input(path);
  if (!input)
    return std::nullopt;
  std::ostringstream output;
  output << input.rdbuf();
  if (input.bad())
    return std::nullopt;
  return output.str();
}

std::vector<std::string> list_names(const fs::path &path,
                                    std::size_t limit = 65536) {
  std::vector<std::string> names;
  std::error_code error;
  fs::directory_iterator iterator(
      path, fs::directory_options::skip_permission_denied, error);
  for (const fs::directory_iterator end;
       iterator != end && !error && names.size() < limit;
       iterator.increment(error)) {
    names.push_back(iterator->path().filename().string());
  }
  std::sort(names.begin(), names.end());
  return names;
}

bool digits(std::string_view value) {
  return !value.empty() &&
         std::all_of(value.begin(), value.end(),
                     [](unsigned char c) { return std::isdigit(c); });
}

std::optional<std::uint64_t> parse_unsigned(std::string value, int base = 10) {
  value = trim(std::move(value));
  if (value.empty())
    return std::nullopt;
  std::size_t consumed = 0;
  try {
    const auto result = std::stoull(value, &consumed, base);
    if (consumed != value.size())
      return std::nullopt;
    return result;
  } catch (...) {
    return std::nullopt;
  }
}

std::map<std::string, std::string> fields(std::string_view text,
                                          char separator = ':') {
  std::map<std::string, std::string> result;
  std::istringstream lines{std::string(text)};
  for (std::string line; std::getline(lines, line);) {
    const auto position = line.find(separator);
    if (position == std::string::npos || position == 0)
      continue;
    result[trim(line.substr(0, position))] = trim(line.substr(position + 1));
  }
  return result;
}

std::optional<std::uint64_t> parse_size(std::string value) {
  std::istringstream input(trim(std::move(value)));
  std::uint64_t amount{};
  std::string unit;
  if (!(input >> amount))
    return std::nullopt;
  input >> unit;
  std::string extra;
  if (input >> extra)
    return std::nullopt;
  std::uint64_t factor = 1;
  if (unit == "KiB")
    factor = 1ULL << 10;
  else if (unit == "MiB")
    factor = 1ULL << 20;
  else if (unit == "GiB")
    factor = 1ULL << 30;
  else if (!unit.empty() && unit != "B")
    return std::nullopt;
  if (amount > std::numeric_limits<std::uint64_t>::max() / factor)
    return std::nullopt;
  return amount * factor;
}

std::optional<Client> parse_fdinfo(std::string_view text,
                                   const std::string &expected_pdev,
                                   std::string &key) {
  const auto data = fields(text);
  const auto driver = data.find("drm-driver");
  const auto pdev = data.find("drm-pdev");
  const auto client_id = data.find("drm-client-id");
  if (driver == data.end() || driver->second != "xe" || pdev == data.end() ||
      pdev->second != expected_pdev || client_id == data.end() ||
      !digits(client_id->second)) {
    return std::nullopt;
  }

  Client client;
  for (const auto &[name, value] : data) {
    constexpr std::string_view resident_prefix = "drm-resident-vram";
    constexpr std::string_view cycles_prefix = "drm-cycles-";
    if (name.starts_with(resident_prefix) &&
        digits(name.substr(resident_prefix.size()))) {
      if (const auto bytes = parse_size(value)) {
        if (client.resident_vram <=
            std::numeric_limits<std::uint64_t>::max() - *bytes)
          client.resident_vram += *bytes;
      }
      continue;
    }
    if (!name.starts_with(cycles_prefix))
      continue;
    const auto engine = name.substr(cycles_prefix.size());
    if (engine.empty())
      continue;
    const auto total = data.find("drm-total-cycles-" + engine);
    const auto capacity = data.find("drm-engine-capacity-" + engine);
    const auto busy_value = parse_unsigned(value);
    const auto total_value =
        total == data.end() ? std::nullopt : parse_unsigned(total->second);
    const auto capacity_value = capacity == data.end()
                                    ? std::optional<std::uint64_t>{1}
                                    : parse_unsigned(capacity->second);
    if (busy_value && total_value && capacity_value && *capacity_value > 0)
      client.engines[engine] = {*busy_value, *total_value, *capacity_value};
  }
  key = expected_pdev + ":" + client_id->second;
  return client;
}

std::optional<Card> find_card() {
  for (const auto &name : list_names(fs::path(kDrmRoot))) {
    if (!name.starts_with("card") || !digits(name.substr(4)))
      continue;
    const fs::path device = fs::path(kDrmRoot) / name / "device";
    const auto uevent = read_text(device / "uevent");
    if (!uevent)
      continue;
    const auto data = fields(*uevent, '=');
    const auto driver = data.find("DRIVER");
    const auto pdev = data.find("PCI_SLOT_NAME");
    if (driver == data.end() || driver->second != "xe" || pdev == data.end())
      continue;
    std::optional<fs::path> hwmon;
    const auto hwmons = list_names(device / "hwmon");
    if (!hwmons.empty())
      hwmon = device / "hwmon" / hwmons.front();
    return Card{name, device, pdev->second, hwmon};
  }
  return std::nullopt;
}

std::map<std::string, Client> read_clients(const std::string &pdev) {
  std::map<std::string, Client> clients;
  std::size_t inspected = 0;
  for (const auto &pid : list_names(fs::path(kProcRoot), kMaxPids)) {
    if (!digits(pid))
      continue;
    const fs::path base = fs::path(kProcRoot) / pid / "fdinfo";
    for (const auto &fd : list_names(base, kMaxFdsPerPid)) {
      if (!digits(fd) || ++inspected > kMaxFdInfoFiles)
        return clients;
      const auto text = read_text(base / fd);
      if (!text || text->find("drm-driver:") == std::string::npos)
        continue;
      std::string key;
      if (auto client = parse_fdinfo(*text, pdev, key);
          client && !clients.contains(key))
        clients.emplace(std::move(key), std::move(*client));
    }
  }
  return clients;
}

std::optional<double> read_temperature(const std::optional<fs::path> &hwmon) {
  if (!hwmon)
    return std::nullopt;
  std::optional<std::uint64_t> maximum;
  for (const auto &name : list_names(*hwmon)) {
    if (!name.starts_with("temp") || !name.ends_with("_input") ||
        !digits(name.substr(4, name.size() - 4 - 6)))
      continue;
    const auto value = read_text(*hwmon / name);
    const auto number = value ? parse_unsigned(*value) : std::nullopt;
    if (number)
      maximum = maximum ? std::max(*maximum, *number) : *number;
  }
  return maximum
             ? std::optional<double>{std::round(static_cast<double>(*maximum) /
                                                100.0) /
                                     10.0}
             : std::nullopt;
}

std::optional<std::uint64_t> read_clock(const fs::path &device) {
  std::optional<std::uint64_t> maximum;
  for (const auto &tile : list_names(device)) {
    if (!tile.starts_with("tile") || !digits(tile.substr(4)))
      continue;
    for (const auto &gt : list_names(device / tile)) {
      if (!gt.starts_with("gt") || !digits(gt.substr(2)))
        continue;
      const auto text = read_text(device / tile / gt / "freq0" / "act_freq");
      const auto value = text ? parse_unsigned(*text) : std::nullopt;
      if (value)
        maximum = maximum ? std::max(*maximum, *value) : *value;
    }
  }
  return maximum;
}

std::optional<std::uint64_t> read_vram_total(const fs::path &device) {
  const auto text = read_text(device / "resource");
  if (!text)
    return std::nullopt;
  std::istringstream lines(*text);
  std::string line;
  for (int index = 0; index <= 2; ++index)
    if (!std::getline(lines, line))
      return std::nullopt;
  std::istringstream values(line);
  std::string start_text, end_text;
  if (!(values >> start_text >> end_text))
    return std::nullopt;
  const auto start = parse_unsigned(start_text, 16);
  const auto end = parse_unsigned(end_text, 16);
  if (!start || !end || *end < *start)
    return std::nullopt;
  const auto bytes = *end - *start + 1;
  if (bytes < (1ULL << 30) || bytes > 256ULL * (1ULL << 30))
    return std::nullopt;
  return bytes;
}

std::optional<double>
utilization(const std::optional<Previous> &previous,
            const std::map<std::string, Client> &clients) {
  if (!previous)
    return std::nullopt;
  std::map<std::string, std::pair<double, std::uint64_t>> engines;
  for (const auto &[key, client] : clients) {
    const auto old_client = previous->clients.find(key);
    if (old_client == previous->clients.end())
      continue;
    for (const auto &[name, current] : client.engines) {
      const auto old = old_client->second.find(name);
      if (old == old_client->second.end() || current.busy < old->second.busy ||
          current.total <= old->second.total)
        continue;
      auto &aggregate = engines[name];
      aggregate.first += static_cast<double>(current.busy - old->second.busy) /
                         static_cast<double>(current.total - old->second.total);
      aggregate.second = std::max(aggregate.second, current.capacity);
    }
  }
  std::optional<double> maximum;
  for (const auto &[_, value] : engines) {
    if (value.second == 0)
      continue;
    const double normalized = value.first / static_cast<double>(value.second);
    maximum = maximum ? std::max(*maximum, normalized) : normalized;
  }
  return maximum
             ? std::optional<double>{std::round(std::clamp(*maximum, 0.0, 1.0) *
                                                1000.0) /
                                     10.0}
             : std::nullopt;
}

std::optional<double>
power(const std::optional<Previous> &previous,
      const std::optional<std::uint64_t> &energy, Clock::time_point now,
      const std::optional<std::uint64_t> &cap_microwatts) {
  if (!previous || !previous->energy_microjoules || !energy ||
      *energy <= *previous->energy_microjoules)
    return std::nullopt;
  const double seconds =
      std::chrono::duration<double>(now - previous->at).count();
  if (!std::isfinite(seconds) || seconds < 0.25)
    return std::nullopt;
  const double watts =
      static_cast<double>(*energy - *previous->energy_microjoules) / 1e6 /
      seconds;
  const double cap =
      cap_microwatts ? static_cast<double>(*cap_microwatts) / 1e6 : 1000.0;
  if (!std::isfinite(watts) || watts < 0 || watts > cap * 1.25)
    return std::nullopt;
  return std::round(watts * 100.0) / 100.0;
}

std::string number(double value, int precision) {
  std::ostringstream output;
  output << std::fixed << std::setprecision(precision) << value;
  auto result = output.str();
  while (result.find('.') != std::string::npos && result.ends_with('0'))
    result.pop_back();
  if (result.ends_with('.'))
    result.pop_back();
  return result;
}

class Collector {
public:
  std::string collect() {
    const auto card = find_card();
    if (!card)
      return R"({"available":false,"reason":"Kein Intel-xe-Gerät gefunden"})";
    const auto now = Clock::now();
    const auto clients = read_clients(card->pdev);
    const auto energy_text =
        card->hwmon ? read_text(*card->hwmon / "energy1_input") : std::nullopt;
    const auto cap_text =
        card->hwmon ? read_text(*card->hwmon / "power1_cap") : std::nullopt;
    const auto energy =
        energy_text ? parse_unsigned(*energy_text) : std::nullopt;
    const auto cap = cap_text ? parse_unsigned(*cap_text) : std::nullopt;
    const auto temperature = read_temperature(card->hwmon);
    const auto clock = read_clock(card->device);
    const auto total = read_vram_total(card->device);
    const auto busy = utilization(previous_, clients);
    const auto watts = power(previous_, energy, now, cap);

    std::uint64_t used = 0;
    for (const auto &[_, client] : clients)
      if (used <=
          std::numeric_limits<std::uint64_t>::max() - client.resident_vram)
        used += client.resident_vram;

    Previous current{now, energy, {}};
    for (const auto &[key, client] : clients)
      current.clients[key] = client.engines;
    previous_ = std::move(current);

    std::vector<std::pair<std::string, std::string>> values;
    if (temperature)
      values.emplace_back("temperatureC", number(*temperature, 1));
    if (clock)
      values.emplace_back("clockMhz", std::to_string(*clock));
    if (total)
      values.emplace_back("vramTotalBytes", std::to_string(*total));
    if (!clients.empty())
      values.emplace_back("vramUsedBytes", std::to_string(used));
    if (busy)
      values.emplace_back("utilizationPercent", number(*busy, 1));
    if (watts)
      values.emplace_back("powerWatts", number(*watts, 2));

    std::vector<std::string> missing;
    if (!busy)
      missing.emplace_back("utilization");
    if (clients.empty() || !total)
      missing.emplace_back("vram");
    if (!temperature)
      missing.emplace_back("temperature");
    if (!watts)
      missing.emplace_back("power");
    if (!clock)
      missing.emplace_back("clock");

    std::ostringstream json;
    json << R"({"available":true,"card":")" << card->name << R"(","values":{)";
    for (std::size_t index = 0; index < values.size(); ++index) {
      if (index)
        json << ',';
      json << '"' << values[index].first << "\":" << values[index].second;
    }
    json << '}';
    if (!missing.empty()) {
      json << R"(,"missing":[)";
      for (std::size_t index = 0; index < missing.size(); ++index) {
        if (index)
          json << ',';
        json << '"' << missing[index] << '"';
      }
      json << ']';
    }
    json << '}';
    return json.str();
  }

private:
  std::optional<Previous> previous_;
};

void stop_handler(int) { running = 0; }

bool send_all(int fd, std::string_view data) {
  while (!data.empty()) {
    const auto sent = ::send(fd, data.data(), data.size(), MSG_NOSIGNAL);
    if (sent < 0) {
      if (errno == EINTR)
        continue;
      return false;
    }
    data.remove_prefix(static_cast<std::size_t>(sent));
  }
  return true;
}

void serve_client(int fd, const std::string &snapshot) {
  pollfd descriptor{fd, POLLIN, 0};
  if (::poll(&descriptor, 1, 250) <= 0)
    return;
  char request[4096];
  const auto size = ::recv(fd, request, sizeof(request), 0);
  if (size <= 0)
    return;
  const std::string_view line(request, static_cast<std::size_t>(size));
  const bool valid = line.starts_with("GET /snapshot HTTP/1.");
  const std::string body = valid ? snapshot : R"({"error":"not found"})";
  std::ostringstream headers;
  headers << "HTTP/1.1 " << (valid ? "200 OK" : "404 Not Found")
          << "\r\nContent-Type: application/json\r\nCache-Control: "
             "no-store\r\nContent-Length: "
          << body.size() << "\r\nConnection: close\r\n\r\n";
  const auto header_text = headers.str();
  send_all(fd, header_text);
  send_all(fd, body);
}

int self_test() {
  const std::string sample = "drm-driver:\txe\n"
                             "drm-client-id:\t3\n"
                             "drm-pdev:\t0000:03:00.0\n"
                             "drm-resident-vram0:\t24576 MiB\n"
                             "drm-cycles-ccs:\t500\n"
                             "drm-total-cycles-ccs:\t2000\n"
                             "drm-engine-capacity-ccs:\t4\n";
  std::string key;
  const auto client = parse_fdinfo(sample, "0000:03:00.0", key);
  if (!client || key != "0000:03:00.0:3" ||
      client->resident_vram != 24ULL * (1ULL << 30) ||
      client->engines.at("ccs").capacity != 4 || parse_size("1 nonsense")) {
    std::cerr << "native GPU helper self-test failed\n";
    return 1;
  }
  const auto now = Clock::now();
  Previous previous{now - std::chrono::seconds(2), 100000000, {}};
  previous.clients[key]["ccs"] = {100, 1000, 4};
  const std::map<std::string, Client> clients{{key, *client}};
  const auto busy = utilization(previous, clients);
  const auto watts = power(previous, 140000000, now, 275000000);
  if (!busy || std::abs(*busy - 10.0) > 0.001 || !watts ||
      std::abs(*watts - 20.0) > 0.01) {
    std::cerr << "native GPU helper counter self-test failed\n";
    return 1;
  }
  std::cout << "native GPU helper self-test passed\n";
  return 0;
}

} // namespace

int main(int argc, char **argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--self-test")
    return self_test();
  const char *configured = std::getenv("OBSERVATORY_GPU_HELPER_SOCKET");
  const std::string socket_path =
      configured ? configured : "/run/local-ai-b70-observatory/gpu.sock";
  if (socket_path.empty() || socket_path.front() != '/' ||
      socket_path.size() >= sizeof(sockaddr_un::sun_path)) {
    std::cerr << "[gpu-helper] invalid Unix socket path\n";
    return 1;
  }

  std::signal(SIGTERM, stop_handler);
  std::signal(SIGINT, stop_handler);
  std::signal(SIGPIPE, SIG_IGN);
  ::unlink(socket_path.c_str());
  const int server =
      ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (server < 0) {
    std::cerr << "[gpu-helper] socket failed: " << std::strerror(errno) << '\n';
    return 1;
  }
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, socket_path.c_str(), socket_path.size() + 1);
  if (::bind(server, reinterpret_cast<sockaddr *>(&address), sizeof(address)) !=
          0 ||
      ::chmod(socket_path.c_str(), 0660) != 0 || ::listen(server, 8) != 0) {
    std::cerr << "[gpu-helper] bind/listen failed: " << std::strerror(errno)
              << '\n';
    ::close(server);
    ::unlink(socket_path.c_str());
    return 1;
  }

  Collector collector;
  std::string snapshot = collector.collect();
  auto next_sample = Clock::now() + kSampleInterval;
  std::cout << "[gpu-helper] listening on " << socket_path << '\n';
  while (running) {
    const auto now = Clock::now();
    if (now >= next_sample) {
      snapshot = collector.collect();
      next_sample = Clock::now() + kSampleInterval;
    }
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(next_sample -
                                                              Clock::now());
    const int timeout =
        static_cast<int>(std::clamp<std::int64_t>(remaining.count(), 0, 2000));
    pollfd descriptor{server, POLLIN, 0};
    const int ready = ::poll(&descriptor, 1, timeout);
    if (ready < 0 && errno != EINTR)
      break;
    if (ready > 0 && (descriptor.revents & POLLIN)) {
      const int client = ::accept4(server, nullptr, nullptr, SOCK_CLOEXEC);
      if (client >= 0) {
        serve_client(client, snapshot);
        ::close(client);
      }
    }
  }
  ::close(server);
  ::unlink(socket_path.c_str());
  return 0;
}
