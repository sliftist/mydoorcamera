import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { connect } from "../helpers/session";
import { inputCss, btnCss } from "../helpers/styles";

@observer
export class ConnectView extends preact.Component<{}, { showPw: boolean }> {
    render() {
        return (
            <div className={css.vbox(14).width("100%").maxWidth(440)}>
                <h1 className={css.fontSize(28)}>mydoorcamera</h1>
                <div className={css.fontSize(13).opacity(0.8)}>Connect to your camera server on the local network.</div>
                <label className={css.vbox(4)}>
                    <span className={css.fontSize(12).opacity(0.7)}>Server IP</span>
                    <input className={inputCss} placeholder="e.g. 10.0.0.189" value={state.ip}
                        onInput={e => runInAction(() => { state.ip = (e.target as HTMLInputElement).value; })} />
                </label>
                <label className={css.vbox(4)}>
                    <span className={css.fontSize(12).opacity(0.7)}>Password (4 words)</span>
                    <div className={css.hbox(6).alignItems("stretch")}>
                        <input className={inputCss + " " + css.flexGrow(1).minWidth(0)} type={this.state.showPw ? "text" : "password"} autoComplete="off" placeholder="four words" value={state.password}
                            onInput={e => runInAction(() => { state.password = (e.target as HTMLInputElement).value; })}
                            onKeyDown={e => { if (e.key === "Enter") void connect(); }} />
                        <button className={btnCss} type="button" title={this.state.showPw ? "Hide the password" : "Show the password"}
                            onClick={() => this.setState({ showPw: !this.state.showPw })}>
                            {this.state.showPw ? "🙈" : "👁"}
                        </button>
                    </div>
                </label>
                <button className={btnCss} disabled={state.connecting || !state.ip.trim()} onClick={() => void connect()}>
                    {state.connecting ? "Connecting…" : "Connect"}
                </button>
                {state.error && (
                    <div className={css.vbox(8).pad2(12, 14).hsl(0, 35, 14).border("1px solid hsl(0,45%,32%)")}>
                        <div className={css.color("hsl(0,80%,76%)").fontSize(13)}>{state.error}</div>
                        {state.showCertLink && (
                            <a className={css.fontSize(14).pointer.color("hsl(210,95%,74%)")}
                                href={`https://${state.ip.trim()}:8443/`} target="_blank" rel="noreferrer">
                                → Click here to open the certificate page and accept it — it'll connect automatically.
                            </a>
                        )}
                    </div>
                )}
            </div>
        );
    }
}
