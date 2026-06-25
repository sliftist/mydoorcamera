// Shared typesafecss class strings (no rounded corners, per house style).

import { css } from "typesafecss";

export const inputCss = css.fontSize(15).pad2(10, 12).hsl(220, 15, 16).color("inherit").border("1px solid hsl(220,15%,30%)").width("100%").toString();
export const btnCss = css.fontSize(15).pad2(10, 18).hsl(220, 90, 55).color("white").border("none").pointer.toString();
export const navBtnCss = css.fontSize(16).pad2(4, 12).hsl(220, 15, 18).color("inherit").border("1px solid hsl(220,15%,30%)").pointer.toString();
export const playBtnCss = css.fontSize(16).pad2(8, 16).hsl(220, 90, 55).color("white").border("none").pointer.toString();
export const liveBtnCss = css.fontSize(14).pad2(8, 14).hsl(0, 75, 48).color("white").border("none").pointer.toString();
export const selectCss = css.fontSize(13).pad2(6, 8).hsl(220, 15, 16).color("inherit").border("1px solid hsl(220,15%,30%)").pointer.toString();
