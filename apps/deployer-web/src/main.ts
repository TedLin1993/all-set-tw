import { mount } from "svelte";
import App from "./app/App.svelte";

const target = document.getElementById("root");
if (!target) throw new Error("Missing #root element");
mount(App, { target });
