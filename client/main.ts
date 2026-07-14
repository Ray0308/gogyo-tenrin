import { APP_TITLE } from "../shared/constants.js";

const title = document.querySelector<HTMLHeadingElement>("#app-title");

if (title) {
  title.textContent = APP_TITLE;
}