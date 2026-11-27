// Copyright © 2026 Michael Shields
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// The embedded files are text. bun-types declares *.yaml as a parsed object,
// and a pattern with a longer fixed part wins over it.

declare module "*/dev.yaml" {
  const text: string;
  export default text;
}

declare module "*.sh" {
  const text: string;
  export default text;
}

declare module "*/github-gateway-credential" {
  const text: string;
  export default text;
}

declare module "*/setup-github-gateway" {
  const text: string;
  export default text;
}

declare module "*/setup-model-gateway" {
  const text: string;
  export default text;
}

declare module "*/setup-secrets" {
  const text: string;
  export default text;
}
