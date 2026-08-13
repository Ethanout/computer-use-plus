using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace ComputerUsePlus {
  internal static class DesktopAgent {
    private const uint BM_CLICK = 0x00F5;
    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP = 0x0101;
    private const uint WM_CHAR = 0x0102;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint MK_LBUTTON = 0x0001;
    private const uint CWP_SKIPINVISIBLE = 0x0001;
    private const uint CWP_SKIPDISABLED = 0x0002;
    private const int VK_SHIFT = 0x10;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int UOI_NAME = 2;
    private static IntPtr jobHandle;
    private static readonly HashSet<int> launchedProcessIds = new HashSet<int>();
    private delegate bool EnumDesktopWindowsProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr window, IntPtr destination, uint flags);
    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr window, ref POINT point);
    [DllImport("user32.dll")]
    private static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT point, uint flags);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumDesktopWindows(IntPtr desktop, EnumDesktopWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int maxCount);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);
    [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")]
    private static extern uint GetWindowThreadProcessIdValue(IntPtr window, out uint processId);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder information, int length, out int needed);
    [DllImport("user32.dll")]
    private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern short VkKeyScan(char character);
    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForSystem();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
      IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
      ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct GUITHREADINFO {
      public int cbSize; public uint flags; public IntPtr hwndActive; public IntPtr hwndFocus;
      public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize;
      public IntPtr hwndCaret; public RECT rcCaret;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int processId, threadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
      public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
      public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    private static string logPath;

    [STAThread]
    private static int Main(string[] args) {
      string pipeName = ReadArg(args, "--pipe");
      logPath = ReadArg(args, "--log");
      if (String.IsNullOrWhiteSpace(pipeName)) return 2;
      try {
        try { SetProcessDpiAwareness(2); } catch (DllNotFoundException) { }
        // Force USER32/UI Automation to attach this process to the STARTUPINFO desktop
        // before the creator releases its desktop handle.
        AutomationElement.RootElement.GetCurrentPropertyValue(AutomationElement.NameProperty);
        InitializeJob();
        Log("agent_starting");
        bool stop = false;
        while (!stop) {
          using (var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None)) {
            Log("pipe_listening");
            pipe.WaitForConnection();
            try {
              string requestLine;
              using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 8192, true)) requestLine = reader.ReadLine();
              if (requestLine == null) continue;
              Dictionary<string, object> request = ParseObject(requestLine);
              Dictionary<string, object> response = Handle(request, ref stop);
              using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 8192, true) { AutoFlush = true }) writer.WriteLine(Json.Serialize(response));
            } catch (IOException error) { Log("client_disconnected:" + error.Message); }
          }
        }
        CloseJob();
        Log("agent_stopped");
        return 0;
      } catch (Exception error) {
        CloseJob();
        Log("agent_error:" + error);
        return 1;
      }
    }

    private static Dictionary<string, object> Handle(Dictionary<string, object> request, ref bool stop) {
      try {
        string operation = StringValue(request, "operation");
        if (operation == "ping") return Ok(new Dictionary<string, object> { { "agent", "ready" } });
        if (operation == "shutdown") { stop = true; return Ok(); }
        if (operation == "launch") return LaunchProcess(StringValue(request, "commandLine"), StringValue(request, "workingDirectory"));
        if (operation == "diagnose") return Diagnose();
        if (operation == "capture") return CaptureWindow(StringValue(request, "windowId"), BoolValue(request, "coordinateGrid"), IntValue(request, "tickPixels", 100));
        if (operation != "driver") return Error("unsupported_agent_operation");
        var parameters = DictionaryValue(request, "params");
        switch (StringValue(request, "driverOperation")) {
          case "listWindows": return OkValue(ListWindows());
          case "findElements": return OkValue(FindElements(StringValue(parameters, "WindowId"), DictionaryValue(parameters, "QueryJson")));
          case "focus": return Focus(StringValue(parameters, "WindowId"));
          case "click": return Click(StringValue(parameters, "WindowId"), DictionaryValue(parameters, "QueryJson"));
          case "setValue": return SetValue(StringValue(parameters, "WindowId"), DictionaryValue(parameters, "QueryJson"), StringValue(parameters, "Value"));
          case "sendKeys": return SendKeysToWindow(StringValue(parameters, "WindowId"), ListValue(parameters, "KeysJson"));
          case "clickAt": return ClickAt(StringValue(parameters, "WindowId"), DictionaryValue(parameters, "BoundsJson"));
          default: return Error("unknown_driver_operation");
        }
      } catch (Exception error) { Log("request_error:" + error); return Error(error.Message); }
    }

    private static void InitializeJob() {
      jobHandle = CreateJobObject(IntPtr.Zero, null);
      if (jobHandle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits, buffer, false);
        if (!SetInformationJobObject(jobHandle, 9, buffer, (uint)size))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject");
      } finally { Marshal.FreeHGlobal(buffer); }
    }

    private static Dictionary<string, object> LaunchProcess(string commandLine, string workingDirectory) {
      if (String.IsNullOrWhiteSpace(commandLine)) return Error("command_line_required");
      var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
      PROCESS_INFORMATION process;
      uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
      if (String.IsNullOrWhiteSpace(workingDirectory)) workingDirectory = AppDomain.CurrentDomain.BaseDirectory;
      if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero,
          workingDirectory, ref startup, out process))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess");
      try {
        if (!AssignProcessToJobObject(jobHandle, process.hProcess)) {
          int error = Marshal.GetLastWin32Error();
          TerminateProcess(process.hProcess, 1);
          throw new System.ComponentModel.Win32Exception(error, "AssignProcessToJobObject");
        }
        if (ResumeThread(process.hThread) == UInt32.MaxValue) {
          int error = Marshal.GetLastWin32Error();
          TerminateProcess(process.hProcess, 1);
          throw new System.ComponentModel.Win32Exception(error, "ResumeThread");
        }
        launchedProcessIds.Add(process.processId);
        return Ok(new Dictionary<string, object> { { "processId", process.processId } });
      } finally {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
      }
    }

    private static void CloseJob() {
      if (jobHandle == IntPtr.Zero) return;
      CloseHandle(jobHandle);
      jobHandle = IntPtr.Zero;
    }

    private static Dictionary<string, object> Click(string windowId, Dictionary<string, object> query) {
      AutomationElement target = FindTarget(Window(windowId), query);
      object pattern;
      string strategy = null;
      string role = target.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
      if (role.Equals("Button", StringComparison.OrdinalIgnoreCase) && target.Current.NativeWindowHandle != 0) {
        SendMessage(new IntPtr(target.Current.NativeWindowHandle), BM_CLICK, IntPtr.Zero, IntPtr.Zero);
        strategy = "win32.message";
      }
      if (strategy == null && target.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) {
        try { ((InvokePattern)pattern).Invoke(); strategy = "uia.invoke"; } catch (InvalidOperationException) { }
      }
      if (strategy == null) {
        try { target.SetFocus(); strategy = "uia.focus"; } catch (InvalidOperationException) { }
      }
      if (strategy == null) return Error("nonintrusive_click_unavailable_on_execution_desktop");
      var response = Ok(new Dictionary<string, object> { { "strategy", strategy } });
      response["element"] = ElementData(target);
      return response;
    }

    private static Dictionary<string, object> SetValue(string windowId, Dictionary<string, object> query, string value) {
      AutomationElement target = FindTarget(Window(windowId), query);
      object pattern;
      if (!target.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return Error("value_pattern_unavailable");
      ((ValuePattern)pattern).SetValue(value ?? "");
      var response = Ok(new Dictionary<string, object> { { "strategy", "uia.value" } });
      response["element"] = ElementData(target);
      return response;
    }

    private static Dictionary<string, object> ClickAt(string windowId, Dictionary<string, object> bounds) {
      IntPtr topLevel = new IntPtr(Int64.Parse(windowId));
      ValidateExecutionWindow(topLevel);
      RECT windowRect;
      if (!GetWindowRect(topLevel, out windowRect)) return Error("window_bounds_unavailable");
      int x = IntValue(bounds, "x") + IntValue(bounds, "width") / 2;
      int y = IntValue(bounds, "y") + IntValue(bounds, "height") / 2;
      if (x < windowRect.left || x >= windowRect.right || y < windowRect.top || y >= windowRect.bottom)
        return Error("coordinate_outside_execution_window");
      try {
        var candidates = new List<AutomationElement>();
        foreach (AutomationElement element in AutomationElement.FromHandle(topLevel).FindAll(TreeScope.Descendants, Condition.TrueCondition)) {
          var rectangle = element.Current.BoundingRectangle;
          if (rectangle.Left <= x && rectangle.Top <= y && rectangle.Right > x && rectangle.Bottom > y) candidates.Add(element);
        }
        candidates.Sort(delegate(AutomationElement left, AutomationElement right) {
          var a = left.Current.BoundingRectangle; var b = right.Current.BoundingRectangle;
          return (a.Width * a.Height).CompareTo(b.Width * b.Height);
        });
        foreach (AutomationElement element in candidates) {
          object invoke;
          string role = element.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
          if (role.Equals("Button", StringComparison.OrdinalIgnoreCase) && element.Current.NativeWindowHandle != 0) {
            SendMessage(new IntPtr(element.Current.NativeWindowHandle), BM_CLICK, IntPtr.Zero, IntPtr.Zero);
            return Ok(new Dictionary<string, object> { { "strategy", "win32.mousemessage" } });
          }
          if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out invoke)) continue;
          try {
            ((InvokePattern)invoke).Invoke();
            return Ok(new Dictionary<string, object> { { "strategy", "uia.coordinate.invoke" } });
          } catch (InvalidOperationException) { }
        }
      } catch (Exception error) { Log("coordinate_uia_fallback:" + error.Message); }
      try {
        AutomationElement element = AutomationElement.FromPoint(new System.Windows.Point(x, y));
        for (int depth = 0; element != null && depth < 5; depth++) {
          object invoke;
          if (element.TryGetCurrentPattern(InvokePattern.Pattern, out invoke)) {
            try {
              ((InvokePattern)invoke).Invoke();
              return Ok(new Dictionary<string, object> { { "strategy", "uia.point.invoke" } });
            } catch (InvalidOperationException) { }
          }
          element = TreeWalker.ControlViewWalker.GetParent(element);
        }
      } catch (Exception error) { Log("coordinate_point_fallback:" + error.Message); }
      // Resolve native controls only within the requested top-level window. A
      // global WindowFromPoint fallback could otherwise click an overlapping
      // window on the execution desktop.
      IntPtr target = topLevel;
      while (true) {
        var point = new POINT { x = x, y = y };
        if (!ScreenToClient(target, ref point)) break;
        IntPtr child = ChildWindowFromPointEx(target, point, CWP_SKIPINVISIBLE);
        if (child == IntPtr.Zero || child == target) break;
        target = child;
      }
      if (!IsWindowEnabled(target)) return Error("coordinate_target_disabled");
      var client = new POINT { x = x, y = y };
      if (!ScreenToClient(target, ref client)) return Error("coordinate_translation_failed");
      IntPtr lParam = new IntPtr((client.y << 16) | (client.x & 0xffff));
      SendMessage(target, WM_LBUTTONDOWN, new IntPtr(MK_LBUTTON), lParam);
      SendMessage(target, WM_LBUTTONUP, IntPtr.Zero, lParam);
      return Ok(new Dictionary<string, object> { { "strategy", "win32.mousemessage" } });
    }

    private static Dictionary<string, object> CaptureWindow(string windowId, bool coordinateGrid, int tickPixels) {
      IntPtr window = new IntPtr(Int64.Parse(windowId));
      ValidateExecutionWindow(window);
      RECT rect;
      if (!GetWindowRect(window, out rect)) return Error("window_bounds_unavailable");
      int width = rect.right - rect.left;
      int height = rect.bottom - rect.top;
      if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return Error("invalid_capture_bounds");
      string directory = Path.GetDirectoryName(logPath) ?? AppDomain.CurrentDomain.BaseDirectory;
      Directory.CreateDirectory(directory);
      string imagePath = Path.Combine(directory, "capture-" + Guid.NewGuid().ToString("N") + ".png");
      using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
      using (Graphics graphics = Graphics.FromImage(bitmap)) {
        IntPtr dc = graphics.GetHdc();
        bool rendered;
        try { rendered = PrintWindow(window, dc, 2); }
        finally { graphics.ReleaseHdc(dc); }
        if (!rendered) return Error("print_window_failed");
        if (coordinateGrid) DrawCoordinateGrid(graphics, width, height, Math.Max(50, Math.Min(tickPixels, 500)));
        bitmap.Save(imagePath, ImageFormat.Png);
      }
      return Ok(new Dictionary<string, object> {
        { "path", imagePath },
        { "scale", (GetDpiForSystem() == 0 ? 96.0 : GetDpiForSystem()) / 96.0 },
        { "bounds", new Dictionary<string, object> { { "x", rect.left }, { "y", rect.top }, { "width", width }, { "height", height } } }
      });
    }

    private static void DrawCoordinateGrid(Graphics graphics, int width, int height, int tick) {
      using (var pen = new Pen(Color.FromArgb(210, 255, 64, 64), 1))
      using (var fill = new SolidBrush(Color.FromArgb(220, 20, 20, 20)))
      using (var text = new SolidBrush(Color.White))
      using (var font = new Font("Segoe UI", 8, FontStyle.Regular, GraphicsUnit.Pixel)) {
        graphics.FillRectangle(fill, 0, 0, width, Math.Min(18, height));
        graphics.FillRectangle(fill, 0, 0, Math.Min(34, width), height);
        for (int x = 0; x < width; x += tick) {
          graphics.DrawLine(pen, x, 0, x, Math.Min(8, height));
          if (x > 0) graphics.DrawString(x.ToString(), font, text, x + 2, 8);
        }
        for (int y = 0; y < height; y += tick) {
          graphics.DrawLine(pen, 0, y, Math.Min(8, width), y);
          if (y > 0) graphics.DrawString(y.ToString(), font, text, 9, y + 2);
        }
        graphics.DrawString("0,0", font, text, 9, 2);
      }
    }

    private static Dictionary<string, object> Focus(string windowId) {
      IntPtr window = new IntPtr(Int64.Parse(windowId));
      ValidateExecutionWindow(window);
      AutomationElement target = AutomationElement.FromHandle(window);
      try { target.SetFocus(); } catch (InvalidOperationException) { }
      SetForegroundWindow(window);
      return Ok(new Dictionary<string, object> { { "window", windowId }, { "strategy", "uia.focus" } });
    }

    private static Dictionary<string, object> SendKeysToWindow(string windowId, ArrayList entries) {
      IntPtr topLevel = new IntPtr(Int64.Parse(windowId));
      ValidateExecutionWindow(topLevel);
      int count = 0;
      foreach (object entry in entries) {
        string key;
        int at = 0;
        var map = entry as Dictionary<string, object>;
        if (map == null) key = Convert.ToString(entry);
        else { key = StringValue(map, "key"); at = IntValue(map, "at"); }
        if (at > 0) Thread.Sleep(Math.Min(at, 30000));
        SendKeyMessages(FocusedWindow(topLevel), key);
        count++;
      }
      return Ok(new Dictionary<string, object> { { "count", count }, { "strategy", "win32.keymessage" } });
    }

    private static IntPtr FocusedWindow(IntPtr topLevel) {
      uint threadId = GetWindowThreadProcessId(topLevel, IntPtr.Zero);
      var info = new GUITHREADINFO { cbSize = Marshal.SizeOf(typeof(GUITHREADINFO)) };
      if (threadId != 0 && GetGUIThreadInfo(threadId, ref info) && info.hwndFocus != IntPtr.Zero) return info.hwndFocus;
      return topLevel;
    }

    private static void SendKeyMessages(IntPtr target, string encoded) {
      if (target == IntPtr.Zero || String.IsNullOrEmpty(encoded)) return;
      var modifiers = new List<int>();
      int index = 0;
      while (index < encoded.Length && (encoded[index] == '^' || encoded[index] == '%' || encoded[index] == '+')) {
        modifiers.Add(encoded[index] == '^' ? VK_CONTROL : encoded[index] == '%' ? VK_MENU : VK_SHIFT);
        index++;
      }
      string key = encoded.Substring(index);
      int virtualKey = VirtualKey(key);
      foreach (int modifier in modifiers) SendMessage(target, WM_KEYDOWN, new IntPtr(modifier), IntPtr.Zero);
      if (virtualKey != 0) SendMessage(target, WM_KEYDOWN, new IntPtr(virtualKey), IntPtr.Zero);
      if (modifiers.Count == 0 && key.Length == 1) SendMessage(target, WM_CHAR, new IntPtr(key[0]), IntPtr.Zero);
      if (virtualKey != 0) SendMessage(target, WM_KEYUP, new IntPtr(virtualKey), IntPtr.Zero);
      for (int i = modifiers.Count - 1; i >= 0; i--) SendMessage(target, WM_KEYUP, new IntPtr(modifiers[i]), IntPtr.Zero);
    }

    private static int VirtualKey(string key) {
      var special = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) {
        { "{ENTER}", 0x0D }, { "{ESC}", 0x1B }, { "{TAB}", 0x09 }, { "{BACKSPACE}", 0x08 },
        { "{DELETE}", 0x2E }, { "{UP}", 0x26 }, { "{DOWN}", 0x28 }, { "{LEFT}", 0x25 }, { "{RIGHT}", 0x27 }
      };
      int value;
      if (special.TryGetValue(key, out value)) return value;
      if (key.StartsWith("{F", StringComparison.OrdinalIgnoreCase) && key.EndsWith("}")) {
        int number;
        if (Int32.TryParse(key.Substring(2, key.Length - 3), out number) && number >= 1 && number <= 24) return 0x6F + number;
      }
      return key.Length == 1 ? (VkKeyScan(key[0]) & 0xff) : 0;
    }

    private static ArrayList ListWindows() {
      var result = new ArrayList();
      var seen = new HashSet<long>();
      IntPtr foreground = GetForegroundWindow();
      var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
      foreach (AutomationElement element in windows) {
        try {
          if (element.Current.NativeWindowHandle == 0) continue;
          var item = new Dictionary<string, object> {
            { "id", element.Current.NativeWindowHandle.ToString() }, { "title", element.Current.Name ?? "" },
            { "className", element.Current.ClassName ?? "" }, { "bounds", Bounds(element.Current.BoundingRectangle) },
            { "isForeground", new IntPtr(element.Current.NativeWindowHandle) == foreground }, { "source", "uia" }
          };
          try { item["process"] = Process.GetProcessById(element.Current.ProcessId).ProcessName; } catch { item["process"] = ""; }
          result.Add(item);
          seen.Add(element.Current.NativeWindowHandle);
        } catch (ElementNotAvailableException) { }
      }
      IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
      if (desktop != IntPtr.Zero) {
        EnumDesktopWindows(desktop, delegate(IntPtr window, IntPtr parameter) {
          if (!IsWindowVisible(window) || seen.Contains(window.ToInt64())) return true;
          RECT rect;
          if (!GetWindowRect(window, out rect) || rect.right <= rect.left || rect.bottom <= rect.top) return true;
          uint processId;
          GetWindowThreadProcessIdValue(window, out processId);
          var item = new Dictionary<string, object> {
            { "id", window.ToInt64().ToString() }, { "title", WindowText(window) },
            { "className", WindowClass(window) },
            { "bounds", new Dictionary<string, object> {
              { "x", rect.left }, { "y", rect.top }, { "width", rect.right - rect.left }, { "height", rect.bottom - rect.top }
            } },
            { "isForeground", window == foreground }, { "source", "win32" }, { "processId", processId }
          };
          try { item["process"] = Process.GetProcessById((int)processId).ProcessName; } catch { item["process"] = ""; }
          result.Add(item);
          seen.Add(window.ToInt64());
          return true;
        }, IntPtr.Zero);
      }
      return result;
    }

    private static Dictionary<string, object> Diagnose() {
      var processes = new ArrayList();
      foreach (Process process in Process.GetProcesses()) {
        try {
          bool inside;
          if (!IsProcessInJob(process.Handle, jobHandle, out inside) || !inside) continue;
          processes.Add(new Dictionary<string, object> {
            { "processId", process.Id }, { "process", process.ProcessName }, { "launchRoot", launchedProcessIds.Contains(process.Id) }
          });
        } catch { }
        finally { process.Dispose(); }
      }
      var launches = new ArrayList();
      foreach (int processId in launchedProcessIds) {
        bool alive = false;
        try { using (Process process = Process.GetProcessById(processId)) alive = !process.HasExited; } catch { }
        launches.Add(new Dictionary<string, object> { { "processId", processId }, { "alive", alive } });
      }
      return Ok(new Dictionary<string, object> {
        { "desktop", UserObjectName(GetThreadDesktop(GetCurrentThreadId())) },
        { "windows", ListWindows() }, { "processes", processes }, { "launches", launches }
      });
    }

    private static string WindowText(IntPtr window) {
      int length = Math.Min(Math.Max(GetWindowTextLength(window) + 1, 2), 32768);
      var text = new StringBuilder(length);
      GetWindowText(window, text, text.Capacity);
      return text.ToString();
    }

    private static string WindowClass(IntPtr window) {
      var name = new StringBuilder(512);
      GetClassName(window, name, name.Capacity);
      return name.ToString();
    }

    private static string UserObjectName(IntPtr handle) {
      if (handle == IntPtr.Zero) return "";
      var name = new StringBuilder(512);
      int needed;
      return GetUserObjectInformation(handle, UOI_NAME, name, name.Capacity * 2, out needed) ? name.ToString() : "";
    }

    private static ArrayList FindElements(string windowId, Dictionary<string, object> query) {
      var result = new ArrayList();
      var all = Window(windowId).FindAll(TreeScope.Descendants, Condition.TrueCondition);
      int limit = Math.Min(Math.Max(IntValue(query, "limit", 10), 1), 50);
      foreach (AutomationElement element in all) {
        if (!Matches(element, query)) continue;
        result.Add(ElementData(element));
        if (result.Count >= limit) break;
      }
      return result;
    }

    private static AutomationElement FindTarget(AutomationElement window, Dictionary<string, object> query) {
      var matches = new List<AutomationElement>();
      string needle = StringValue(query, "text");
      var all = window.FindAll(TreeScope.Descendants, Condition.TrueCondition);
      foreach (AutomationElement element in all) if (Matches(element, query)) matches.Add(element);
      if (matches.Count == 0) throw new InvalidOperationException("target_not_found");
      var exact = matches.FindAll(element => String.Equals(element.Current.Name, needle, StringComparison.Ordinal));
      if (exact.Count == 1) return exact[0];
      if (exact.Count > 1 || matches.Count > 1) throw new InvalidOperationException("target_ambiguous");
      return matches[0];
    }

    private static bool Matches(AutomationElement element, Dictionary<string, object> query) {
      try {
        if (!BoolValue(query, "includeOffscreen") && element.Current.IsOffscreen) return false;
        string needle = StringValue(query, "text");
        string role = StringValue(query, "role");
        string automationId = StringValue(query, "automationId");
        string className = StringValue(query, "className");
        if (role.Equals("textbox", StringComparison.OrdinalIgnoreCase) || role.Equals("input", StringComparison.OrdinalIgnoreCase)) role = "Edit";
        string name = element.Current.Name ?? "";
        string actualRole = element.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
        return (String.IsNullOrEmpty(needle) || name.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) &&
          (String.IsNullOrEmpty(role) || actualRole.IndexOf(role, StringComparison.OrdinalIgnoreCase) >= 0) &&
          (String.IsNullOrEmpty(automationId) || String.Equals(element.Current.AutomationId ?? "", automationId, StringComparison.OrdinalIgnoreCase)) &&
          (String.IsNullOrEmpty(className) || String.Equals(element.Current.ClassName ?? "", className, StringComparison.OrdinalIgnoreCase));
      } catch (ElementNotAvailableException) { return false; }
    }

    private static Dictionary<string, object> ElementData(AutomationElement element) {
      var current = element.Current;
      return new Dictionary<string, object> {
        { "name", current.Name ?? "" }, { "role", current.ControlType.ProgrammaticName.Replace("ControlType.", "") },
        { "automationId", current.AutomationId ?? "" }, { "className", current.ClassName ?? "" },
        { "processId", current.ProcessId }, { "bounds", Bounds(current.BoundingRectangle) },
        { "enabled", current.IsEnabled }, { "offscreen", current.IsOffscreen }, { "handle", current.NativeWindowHandle },
        { "value", ElementValue(element) }
      };
    }

    private static string ElementValue(AutomationElement element) {
      object pattern;
      try {
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return ((ValuePattern)pattern).Current.Value ?? "";
      } catch (ElementNotAvailableException) { }
      return "";
    }

    private static Dictionary<string, object> Bounds(System.Windows.Rect rect) {
      return new Dictionary<string, object> { { "x", (int)rect.Left }, { "y", (int)rect.Top }, { "width", (int)rect.Width }, { "height", (int)rect.Height } };
    }
    private static AutomationElement Window(string id) {
      IntPtr handle = new IntPtr(Int64.Parse(id));
      ValidateExecutionWindow(handle);
      return AutomationElement.FromHandle(handle);
    }
    private static void ValidateExecutionWindow(IntPtr window) {
      if (window == IntPtr.Zero || !IsWindow(window)) throw new InvalidOperationException("window_not_found");
      uint threadId = GetWindowThreadProcessId(window, IntPtr.Zero);
      IntPtr targetDesktop = threadId == 0 ? IntPtr.Zero : GetThreadDesktop(threadId);
      IntPtr executionDesktop = GetThreadDesktop(GetCurrentThreadId());
      if (targetDesktop == IntPtr.Zero || executionDesktop == IntPtr.Zero || targetDesktop != executionDesktop)
        throw new InvalidOperationException("window_not_on_execution_desktop");
    }
    private static Dictionary<string, object> Ok() { return new Dictionary<string, object> { { "ok", true } }; }
    private static Dictionary<string, object> Ok(Dictionary<string, object> extra) { var result = Ok(); foreach (var pair in extra) result[pair.Key] = pair.Value; return result; }
    private static Dictionary<string, object> OkValue(object value) { return Ok(new Dictionary<string, object> { { "value", value } }); }
    private static Dictionary<string, object> Error(string message) { return new Dictionary<string, object> { { "ok", false }, { "error", message } }; }
    private static Dictionary<string, object> ParseObject(string json) { return String.IsNullOrWhiteSpace(json) ? new Dictionary<string, object>() : Json.Deserialize<Dictionary<string, object>>(json); }
    private static Dictionary<string, object> DictionaryValue(Dictionary<string, object> map, string key) { object value; return map.TryGetValue(key, out value) && value is Dictionary<string, object> ? (Dictionary<string, object>)value : new Dictionary<string, object>(); }
    private static ArrayList ListValue(Dictionary<string, object> map, string key) { object value; return map.TryGetValue(key, out value) && value is ArrayList ? (ArrayList)value : new ArrayList(); }
    private static string StringValue(Dictionary<string, object> map, string key) { object value; return map.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : ""; }
    private static bool BoolValue(Dictionary<string, object> map, string key) { object value; return map.TryGetValue(key, out value) && value != null && Convert.ToBoolean(value); }
    private static int IntValue(Dictionary<string, object> map, string key, int fallback = 0) { object value; return map.TryGetValue(key, out value) && value != null ? Convert.ToInt32(value) : fallback; }
    private static string ReadArg(string[] args, string name) { for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1]; return null; }
    private static void Log(string message) { if (!String.IsNullOrWhiteSpace(logPath)) File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, new UTF8Encoding(false)); }
  }
}
