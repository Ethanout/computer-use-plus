using System;
using System.Drawing;
using System.Windows.Forms;

internal static class IsolatedWindowFixture {
  [STAThread]
  private static void Main(string[] args) {
    string suffix = args.Length > 0 ? args[0] : "default";
    Application.EnableVisualStyles();
    var form = new Form {
      Text = "ComputerUsePlus-Isolated-" + suffix,
      ClientSize = new Size(420, 180),
      StartPosition = FormStartPosition.CenterScreen
    };
    var input = new TextBox { Name = "fixtureInput", AccessibleName = "Fixture Input", Left = 90, Top = 30, Width = 230 };
    var button = new Button { Name = "fixtureButton", Text = "Fixture Button", Left = 130, Top = 85, Width = 150, Height = 36 };
    button.Click += delegate { form.Text = "ComputerUsePlus-Clicked-" + suffix + "-" + input.Text; };
    form.Controls.Add(input);
    form.Controls.Add(button);
    Application.Run(form);
  }
}
