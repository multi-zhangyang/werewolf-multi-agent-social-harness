import type { ThemeConfig } from "antd";

/** Static antd theme for the research cockpit shell. */
export const cockpitTheme: ThemeConfig = {
  token: {
    borderRadius: 8,
    borderRadiusLG: 12,
    colorPrimary: "#3558d6",
    colorInfo: "#3558d6",
    colorLink: "#3558d6",
    colorSuccess: "#0e7a4e",
    colorWarning: "#b54708",
    colorError: "#b42318",
    colorBgLayout: "#f2f5fa",
    colorBgContainer: "#ffffff",
    colorBorder: "#d5dced",
    colorBorderSecondary: "#e3e8f2",
    colorText: "#101828",
    colorTextSecondary: "#475467",
    controlHeight: 32,
    fontFamily:
      "\"Inter\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Source Han Sans SC\", Arial, sans-serif",
    boxShadowTertiary:
      "0 1px 2px rgba(15, 23, 42, 0.04), 0 2px 8px -2px rgba(15, 23, 42, 0.06)"
  },
  components: {
    Layout: {
      bodyBg: "#f2f5fa",
      headerBg: "#ffffff",
      siderBg: "#101a30"
    },
    Card: {
      headerBg: "transparent",
      bodyPadding: 16,
      headerFontSize: 14
    },
    Menu: {
      itemBorderRadius: 8,
      itemMarginInline: 0,
      itemMarginBlock: 3,
      itemSelectedBg: "#e8edfd",
      darkItemBg: "transparent",
      darkSubMenuItemBg: "transparent",
      darkItemColor: "rgba(226, 232, 240, 0.78)",
      darkItemHoverBg: "rgba(148, 163, 184, 0.14)",
      darkItemHoverColor: "#f8fafc",
      darkItemSelectedBg: "#3558d6",
      darkItemSelectedColor: "#ffffff"
    },
    Table: {
      headerBg: "#f7f9fd",
      headerColor: "#566176",
      cellPaddingBlockSM: 9,
      cellPaddingInlineSM: 10,
      rowHoverBg: "#f4f7fd"
    },
    Tabs: {
      itemSelectedColor: "#3558d6",
      inkBarColor: "#3558d6",
      titleFontSize: 14
    },
    Button: {
      primaryShadow: "0 1px 2px rgba(53, 88, 214, 0.28)",
      fontWeight: 500
    }
  }
};
